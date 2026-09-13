#!/usr/bin/env node

/**
 * create-napukettoqq 入口（2026-08-07 美化 v3，交互层用 @clack/prompts——
 * 现代脚手架交互标准，create-vue / create-turbo 同款）。
 *
 * 用法：
 *   create-napukettoqq                # intro + 交互问部署文件夹名（默认 NapukettoQQ）
 *   create-napukettoqq my-bot         # 位置参数指定文件夹名，跳过命名交互
 *   create-napukettoqq my-bot -f      # 目标目录非空时强制清空覆盖
 *   create-napukettoqq -y             # 全默认（命名用默认值）
 *   create-napukettoqq -h             # 打印帮助
 *
 * 流程：intro → 问文件夹名 → 目标目录准备（非空需确认清空）→ spinner 生成骨架
 *   （package.json / napuketto.toml）→ 用调用方包管理器自动 install →
 *   打开 napuketto.toml 供填写 QQ 号（不自动启动）+ 打印启动指引 → outro 收尾。
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { cancel, confirm, intro, log, outro, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import type { PackageManager, ScaffoldResult } from "./scaffold.js";
import {
    checkDirStatus,
    DEFAULT_PROJECT_NAME,
    detectPackageManager,
    pmBin,
    resolveTargetDir,
    scaffoldProject,
    validateProjectName,
} from "./scaffold.js";

// picocolors 是 CJS 包（无 ESM 命名导出），Node ESM 下需 default import 再解构
const { blue, bold, cyan, dim, red, yellow } = pc;

/** CLI 参数解析结果。 */
interface CliOptions {
    /** 位置参数：部署文件夹名（可选）。 */
    name?: string;
    /** -f/--forced：目标目录非空时强制清空覆盖。 */
    forced: boolean;
    /** -y/--yes：跳过所有交互提示（使用默认值）。 */
    yes: boolean;
    /** -h/--help：显示帮助。 */
    help: boolean;
}

/** 帮助文本（-h/--help）。 */
const HELP = `  用法: create-napukettoqq [name] [选项]

  选项:
    -f, --forced   目标目录非空时强制清空并覆盖
    -y, --yes      跳过所有交互提示（使用默认值）
    -h, --help     显示本帮助
`;

/** 配置文件文件名（生成后引导用户填写 QQ 号）。 */
const CONFIG_FILE = "napuketto.toml";

/**
 * 用系统默认应用打开文件（引导编辑配置用；尽力而为，失败不阻塞创建流程）。
 * Windows：经 cmd.exe 执行内建 start（CreateProcess 不认内建命令）；
 * macOS/Linux：open / xdg-open。detached + unref：不挂到脚手架进程树。
 */
function openInEditor(file: string): void {
    try {
        if (process.platform === "win32") {
            // start 首参是窗口标题（"" 占位），文件路径带引号防空格
            spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${file}"`], {
                stdio: "ignore",
                windowsHide: true,
                detached: true,
            }).unref();
            return;
        }
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        spawn(opener, [file], { stdio: "ignore", detached: true }).unref();
    } catch {
        // 打开失败不影响创建流程（提示仍会打印）
    }
}

/** 解析命令行参数（flag 仅三个，手写保持自包含，不引 yargs-parser）。 */
function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = { forced: false, yes: false, help: false };
    for (const arg of argv) {
        if (arg === "-f" || arg === "--forced") {
            opts.forced = true;
        } else if (arg === "-y" || arg === "--yes") {
            opts.yes = true;
        } else if (arg === "-h" || arg === "--help") {
            opts.help = true;
        } else if (arg.startsWith("-")) {
            throw new Error(`未知参数：${arg}`);
        } else if (opts.name === undefined) {
            opts.name = arg;
        } else {
            throw new Error(`多余的位置参数：${arg}`);
        }
    }
    return opts;
}

/** 读取脚手架自身版本号（intro 显示；dist 场景 import.meta.url 指向包内）。 */
function readVersion(): string {
    try {
        const ownPkg = JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version?: string };
        return ownPkg.version ?? "0.0.0";
    } catch {
        // package.json 缺失（异常环境）→ 兜底
        return "0.0.0";
    }
}

/** 交互询问部署文件夹名（回车取默认值；-y 直接返回默认值）。 */
async function askProjectName(yes: boolean): Promise<string> {
    if (yes) {
        return DEFAULT_PROJECT_NAME;
    }
    // placeholder = 淡灰默认名：直接回车 = 用默认名，键入任意字符 = 从空自定义。
    // 不设 initialValue——否则 clack 渲染的是已输入态（蓝色、光标在末尾），
    // 淡灰 placeholder 不显示（对齐 koishi create 的观感）。
    const name = await text({
        message: "部署文件夹名",
        placeholder: DEFAULT_PROJECT_NAME,
        validate: (input: string | undefined) => {
            // 空输入 = 使用默认名，不报错
            if (input === undefined || input.trim() === "") {
                return undefined;
            }
            try {
                validateProjectName(input);
                return undefined;
            } catch (err) {
                return err instanceof Error ? err.message : String(err);
            }
        },
    });
    // 不用 isCancel：@clack/prompts 1.8 起类型守卫收窄为 `value is typeof CANCEL_SYMBOL`
    // （unique symbol），无法把 `string | symbol` 里的 symbol 排除掉，收窄失效。
    // 这里按运行期类型判定，语义等价且不依赖上游类型细节。
    if (typeof name !== "string") {
        cancel("操作已取消");
        process.exit(0);
    }
    const trimmed = name.trim();
    return trimmed === "" ? DEFAULT_PROJECT_NAME : validateProjectName(trimmed);
}

/**
 * 包管理器品牌色（美化 v4，对齐 koishi create 观感）。
 * 16 色近似 + bold：兼容所有终端（不依赖 truecolor），Windows Terminal /
 * 老 conhost 都能正常显示。只做「标题 + 命令」两层，不做三套 UI。
 */
function brandColor(pm: PackageManager): (text: string) => string {
    switch (pm) {
        case "pnpm":
            return (t) => yellow(bold(t));
        case "yarn":
            return (t) => blue(bold(t));
        case "npm":
            return (t) => red(bold(t));
    }
}

/**
 * 生成后的项目骨架文件树（提升完成感，dim 树枝 + 品牌色勾）。
 * yarn 时多一项空 yarn.lock（隔离独立项目，见 scaffold.ts 注释），树枝符按是否
 * 含该文件调整（末项用 └──，其余用 ├──）。
 */
function renderTree(dirName: string, brand: (t: string) => string, pm: PackageManager): string {
    const hasLock = pm === "yarn";
    const tomlBranch = hasLock ? "  ├── " : "  └── ";
    const lines = [
        brand("✓") + dim(" 生成的文件："),
        dim(`  ${dirName}/`),
        dim("  ├── ") + cyan("package.json"),
        dim(tomlBranch) + cyan("napuketto.toml"),
    ];
    if (hasLock) {
        lines.push(dim("  └── ") + cyan("yarn.lock") + dim("  # 空：隔离独立项目"));
    }
    return lines.join("\n");
}

/** 询问是否移除现有文件并继续（目标目录非空时）。 */
async function confirmRemove(dirName: string): Promise<boolean> {
    const ok = await confirm({
        message: `目录 "${dirName}" 已存在且非空，移除现有文件并继续？`,
        initialValue: false,
    });
    if (typeof ok !== "boolean") {
        cancel("操作已取消");
        process.exit(0);
    }
    return ok;
}

/** 空白/引号判定。 */
const SHELL_WHITESPACE_RE = /[\s"]/;
/** 引号及其紧邻的前导反斜杠串。 */
const QUOTED_BACKSLASH_RE = /(\\*)"/g;
/** 结尾反斜杠串（紧邻收口引号）。 */
const TRAILING_BACKSLASH_RE = /(\\+)$/;

/**
 * 拼命令行时按 MSVCRT 解析规则转义：引号 → \"，紧邻引号的反斜杠串翻倍
 * （n 个反斜杠 + 引号编码为 2n+1 个反斜杠 + \"），结尾收口前同样翻倍，
 * 否则路径尾部 \ 会与收口引号合成 \" 被解析为字面引号导致参数截断。
 * （参数均为内部字面量，仅兜底。）
 */
function quoteShellArg(arg: string): string {
    if (!SHELL_WHITESPACE_RE.test(arg)) {
        return arg;
    }
    const escaped = arg
        .replace(QUOTED_BACKSLASH_RE, '$1$1\\"')
        .replace(TRAILING_BACKSLASH_RE, "$1$1");
    return `"${escaped}"`;
}

/**
 * 去掉 NODE_OPTIONS 里 yarn dlx 注入的 PnP 加载器条目（--require/--import 后跟
 * .pnp.cjs / .pnp.loader.mjs 路径），其余选项原样保留。
 *
 * 背景：`yarn create napukettoqq` 实为 `yarn dlx`，脚手架本身跑在临时 PnP
 * 项目里，其 PnP 钩子经 NODE_OPTIONS 注入进程环境。install 子进程若继承该变量，
 * corepack 解析 yarn 版本时 `require("corepack/package.json")` 会被 PnP 拦截，
 * 报「tried to access corepack, but it isn't declared in your dependencies」。
 * 生成的用户项目与脚手架的 PnP 上下文无关，剥掉即可恢复标准 Node 解析。
 */
function subprocessEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const nodeOptions = env["NODE_OPTIONS"];
    if (nodeOptions !== undefined) {
        // 逐个剥掉 PnP 加载器条目（路径含空格时 Yarn 不生成，\S* 足够）
        const cleaned = nodeOptions
            .replace(/(?:^|\s)--(?:require|import)(?:=|\s+)\S*\.pnp\.(?:cjs|loader\.mjs)/g, "")
            .replace(/\s{2,}/g, " ")
            .trim();
        if (cleaned !== nodeOptions) {
            if (cleaned === "") {
                delete env["NODE_OPTIONS"];
            } else {
                env["NODE_OPTIONS"] = cleaned;
            }
        }
    }
    return env;
}

/** 前台执行命令（stdio 继承，用户可见进度/交互），返回退出码。 */
function runInteractive(bin: string, args: string[], cwd: string): Promise<number> {
    return new Promise((resolve) => {
        // Windows 下 .cmd shim 不能直接 CreateProcess 执行，需 shell:true 经 cmd.exe；
        // 但 Node ≥22 对「shell:true + args 数组」触发 DEP0190 告警（args 仅简单拼接、不转义），
        // 因此 shell 模式下把命令拼成单个字符串传给 spawn 以规避告警；
        // POSIX 下无 shell，保持 bin + args。
        const shell = process.platform === "win32";
        const child = spawn(
            shell ? [bin, ...args.map(quoteShellArg)].join(" ") : bin,
            shell ? [] : args,
            {
                cwd,
                env: subprocessEnv(),
                stdio: "inherit",
                windowsHide: false,
                shell,
            },
        );
        child.on("exit", (code) => {
            resolve(code ?? 0);
        });
    });
}

/** 目标目录准备：非空需确认清空（-f 跳过确认；-y 不隐式清空）。返回 null = 已取消。 */
async function prepareTargetDir(
    dirName: string,
    opts: CliOptions,
): Promise<{ targetDir: string; overwrite: boolean } | null> {
    const targetDir = resolveTargetDir(dirName);
    let overwrite = false;
    if ((await checkDirStatus(targetDir)) === "nonempty") {
        if (!opts.forced) {
            log.warn(`目标目录 "${dirName}" 已存在且非空。`);
            overwrite = await confirmRemove(dirName);
            if (!overwrite) {
                outro("已取消，未做任何修改。");
                return null;
            }
        } else {
            overwrite = true;
        }
    }
    return { targetDir, overwrite };
}

/** 安装依赖（失败提示手动安装路径）。返回是否继续。 */
async function installDeps(pm: PackageManager, result: ScaffoldResult): Promise<boolean> {
    const color = brandColor(pm);
    log.info("前置要求：本机已安装 QQ NT（wrapper.node 来自 QQ 安装目录）。");
    log.info(`正在安装依赖（${color(pm)} install）...`);
    const installCode = await runInteractive(pmBin(pm), ["install"], result.dir);
    if (installCode === 0) {
        return true;
    }
    log.error(`依赖安装失败（退出码 ${installCode}）。请手动执行：`);
    log.step(`cd ${result.dir}`);
    log.step(color(`${pm} install`));
    outro("创建失败，请手动安装后重试。");
    process.exitCode = 1;
    return false;
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(HELP);
        return;
    }

    // 包管理器提前检测：intro 品牌色 + install/start 命令都按它定向
    const pm = detectPackageManager();
    const brand = brandColor(pm);

    // intro：品牌色标题（按调用方包管理器取色，PNPM 黄 / Yarn 蓝 / npm 红）
    intro(brand(`create-napukettoqq  v${readVersion()}`));

    const dirName = opts.name ?? (await askProjectName(opts.yes));
    const prepared = await prepareTargetDir(dirName, opts);
    if (prepared === null) {
        return;
    }
    const { targetDir, overwrite } = prepared;

    // 生成骨架（spinner 进度）
    const s = spinner();
    s.start(`正在生成项目骨架 ${dirName} ...`);
    const result = await scaffoldProject(dirName, overwrite, pm);
    s.stop(`项目骨架已生成：${dirName}`);
    log.message(renderTree(dirName, brand, pm));
    log.success(`位置：${result.dir}`);

    // 自动安装依赖（用调用方包管理器）
    if (!(await installDeps(pm, result))) {
        return;
    }

    // 不自动启动（2026-08-16 用户拍板）：打开配置文件供填写 QQ 号 + 打印启动指引。
    // 占位账号（qq = "123456"）启动无意义，且自动前台运行会占用终端。
    log.message(`请编辑 ${CONFIG_FILE} 填写你的 QQ 号（[[accounts]] 段 qq 字段），然后启动：`);
    if (targetDir !== process.cwd()) {
        const related = relative(process.cwd(), targetDir);
        log.step(`cd ${related}`);
    }
    log.step(brand(`${pm} start`));
    log.message("启动后 Ctrl+C 停止；协议与端口配置见项目内 napuketto.toml。");
    openInEditor(join(result.dir, CONFIG_FILE));

    outro("完成。");
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`创建失败：${message}`);
    process.exitCode = 1;
});
