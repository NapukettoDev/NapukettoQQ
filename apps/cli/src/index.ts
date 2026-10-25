#!/usr/bin/env node

/**
 * @napuketto/cli 入口（P2-6 + P6，2026-08-05；2026-08-07 用户拍板：只保留自建宿主；
 * 2026-08-08 配置结构拍板：账号必填，协议配置嵌在账号内）
 *
 * commander 参数解析：
 *   - 单账号：-q <uin> → runSingleAccount（自建宿主：标准 node + stub QQNT.dll，不拉起 QQ）
 *   - 多账号：-q A -q B 或 supervisor 子命令 → runSupervisor（子进程编排）
 *   - 无 -q：读全局配置 accounts（至少一个，账号必填）→ supervisor 拉起全部启用账号
 *   - config 子命令：init / list / apply / validate（主配置管理）
 *   - 退出码契约（2026-10-25）：0 = 请求式优雅关停；78 = 配置校验失败（ConfigError
 *     一族，宿主消费，免重启）；其余错误 = 1（handleActionError 统一出口）
 *
 * 路线 B（拉起 QQ + 注入）已淘汰（2026-08-07 用户拍板），相关入口已移除。
 */

import process from "node:process";
import { resolveDataRoot } from "@napuketto/kernel";
import { Command } from "commander";
import { handleActionError } from "./action-error.js";
import { runSingleAccount } from "./boot.js";
import {
    cmdConfigApply,
    cmdConfigInit,
    cmdConfigList,
    cmdConfigValidate,
    loadCliConfigWithSource,
} from "./config-cmds.js";
import { resolveCliLogConfig } from "./logger.js";
import { cmdRestart, cmdStatus, cmdStop } from "./ops-commands.js";
import { runSupervisor } from "./supervisor.js";

/** commander collect：累积 -q 多值。 */
function collectQq(value: string, prev: string[]): string[] {
    prev.push(value);
    return prev;
}

/** 启动字符画（NapukettoQQ 品牌标识，内嵌；art 含反引号/反斜杠，用数组逐行转义）。 */
const BANNER = [
    "    _   __                  __        __  __        ____  ____ ",
    "   / | / /___ _____  __  __/ /_____  / /_/ /_____  / __ \\/ __ \\",
    "  /  |/ / __ `/ __ \\/ / / / //_/ _ \\/ __/ __/ __ \\/ / / / / / /",
    " / /|  / /_/ / /_/ / /_/ / ,< /  __/ /_/ /_/ /_/ / /_/ / /_/ / ",
    "/_/ |_/\\__,_/ .___/\\__,_/_/|_|\\___/\\__/\\__/\\____/\\___\\_\\___\\_\\ ",
    "           /_/                                                 ",
].join("\n");

/** 构造可选 dataDir 参数（exactOptionalPropertyTypes 不允许显式 undefined）。 */
function withDataDir(dataDir: string | undefined): { dataDir?: string } {
    if (dataDir === undefined) {
        return {};
    }
    return { dataDir };
}

/** 构造可选 stubDir 参数（同 withDataDir）。 */
function withStubDir(stubDir: string | undefined): { stubDir?: string } {
    if (stubDir === undefined) {
        return {};
    }
    return { stubDir };
}

/** 构造可选 qqPath 参数（同 withDataDir）。 */
function withQqPath(qqPath: string | undefined): { qqPath?: string } {
    if (qqPath === undefined) {
        return {};
    }
    return { qqPath };
}

/** 读主命令已解析的 data-dir（-d 定义在主命令，子命令经此共享）。 */
function rootDataDir(program: Command): { dataDir?: string } {
    return withDataDir(program.opts<{ dataDir?: string }>().dataDir);
}

/** 注册 config 子命令（init/list/apply，P6；-d 复用主命令 option）。 */
function registerConfigCommands(program: Command): void {
    const configCmd = program.command("config").description("全局配置管理（napuketto.toml）");
    configCmd
        .command("init")
        .description("生成默认全局配置")
        .action(async () => {
            try {
                await cmdConfigInit(rootDataDir(program));
            } catch (err) {
                handleActionError(err);
            }
        });
    configCmd
        .command("list")
        .description("列出全局配置与账号配置")
        .action(async () => {
            try {
                await cmdConfigList(rootDataDir(program));
            } catch (err) {
                handleActionError(err);
            }
        });
    configCmd
        .command("apply <file>")
        .description("应用外部配置（TOML/JSON，校验后写回全局配置）")
        .action(async (file: string) => {
            try {
                await cmdConfigApply(file, rootDataDir(program));
            } catch (err) {
                handleActionError(err);
            }
        });
    // config validate（2026-10-25）：宿主拉起前预检；exit 0 合法 / 78 校验失败
    // （与运行时同一校验器与错误文案）/ 1 用法错误。纯只读（文件缺失不落模板）。
    configCmd
        .command("validate")
        .description(
            "校验配置（--config <path> / --config-json <json> 二选一；无参 = 校验生效配置）",
        )
        .option("--config <path>", "待校验配置文件路径（.toml/.json 按扩展名解析）")
        .option("--config-json <json>", "待校验内联配置 JSON 文本")
        .action(async (opts: { config?: string; configJson?: string }) => {
            try {
                const result = await cmdConfigValidate({
                    configPath: opts.config,
                    configJson: opts.configJson,
                    ...rootDataDir(program),
                });
                // 校验结果为功能输出（宿主 grep 消费），保持原样 stdout 单行
                process.stdout.write(
                    result.source === "inline"
                        ? "配置校验通过（来源: inline）\n"
                        : `配置校验通过（来源: file ${result.path}）\n`,
                );
            } catch (err) {
                handleActionError(err);
            }
        });
}

/** 注册 supervisor 子命令（读主配置 accounts 批量拉起，P6；-d 复用主命令 option）。 */
function registerSupervisorCommand(program: Command): void {
    program
        .command("supervisor")
        .description("多账号编排（读全局配置 accounts 拉起子进程）")
        .action(async () => {
            try {
                await runSupervisor(rootDataDir(program));
            } catch (err) {
                handleActionError(err);
            }
        });
}

/** 运维子命令公共壳：解析数据根 + 可选 -q 参数，统一 handleActionError 出口。 */
function opsAction(
    program: Command,
    run: (dataRoot: string, arg: { qq?: string }) => void | Promise<void>,
): (opts: { qq?: string }) => Promise<void> {
    return async (opts) => {
        try {
            const dataRoot = resolveDataRoot(rootDataDir(program).dataDir);
            await run(dataRoot, opts.qq !== undefined ? { qq: opts.qq } : {});
        } catch (err) {
            handleActionError(err);
        }
    };
}

/** 注册运维子命令（status/stop/restart，2026-09-08 T8；-q 复用主命令 option）。 */
function registerOpsCommands(program: Command): void {
    program
        .command("status")
        .description("查看各账号运行状态（读 runtime.json + 进程存活检测）")
        .option("-q, --qq <uin>", "只看指定账号")
        .action(opsAction(program, (dataRoot, arg) => cmdStatus(dataRoot, arg)));
    program
        .command("stop")
        .description(
            "停止账号进程树（无 -q 停 supervisor 全部；-q 停单账号，supervisor 守护时会自动拉起）",
        )
        .option("-q, --qq <uin>", "目标账号（缺省停 supervisor + 全部账号）")
        .action(opsAction(program, (dataRoot, arg) => cmdStop(dataRoot, arg)));
    program
        .command("restart")
        .description("重启账号（无 -q 重启 supervisor 全量；-q 重启单账号；detached 拉起）")
        .option("-q, --qq <uin>", "目标账号（缺省重启 supervisor 全量）")
        .action(opsAction(program, (dataRoot, arg) => cmdRestart(dataRoot, arg)));
}

/** 单账号启动分支（-q 单值；构造 bootOptions 后走 runSingleAccount）。 */
async function runSingleAccountBranch(
    opts: { dataDir?: string; qqPath?: string; stubDir?: string },
    qqs: string[],
): Promise<void> {
    const [only] = qqs;
    if (only === undefined) {
        return;
    }
    await runSingleAccount({
        qq: only,
        ...withDataDir(opts.dataDir),
        ...withQqPath(opts.qqPath),
        ...withStubDir(opts.stubDir),
    });
}

/** 无 -q 时：读全局配置 accounts（账号必填，2026-08-08 拍板），supervisor 拉起全部启用账号。
 * 不再有「配置为空 → 交互式单账号登录」老路径：缺账号直接报错提示编辑模板。
 * 配置加载内联优先（NAPKETTO_CONFIG_JSON > 文件）；校验失败 ConfigError → exit 78。 */
async function autoStart(opts: { dataDir?: string; stubDir?: string }): Promise<void> {
    const { config } = await loadCliConfigWithSource(withDataDir(opts.dataDir));
    if (config.accounts.length === 0) {
        // parseCliConfig 已强制至少一个，此处防御
        throw new Error("主配置没有账号，请编辑 napuketto.toml 填写 [[accounts]] 段");
    }
    await runSupervisor({ ...withDataDir(opts.dataDir), ...withStubDir(opts.stubDir) });
}

/** 主命令分发：无 -q 读配置 supervisor 拉起 / 单 -q 单账号 / 多 -q supervisor。 */
async function dispatchMainAction(opts: {
    qq?: string[];
    dataDir?: string;
    qqPath?: string;
    stubDir?: string;
}): Promise<void> {
    const qqs = opts.qq ?? [];
    if (qqs.length === 0) {
        await autoStart(opts);
        return;
    }
    if (qqs.length === 1) {
        await runSingleAccountBranch(opts, qqs);
        return;
    }
    await runSupervisor({ qqs, ...withDataDir(opts.dataDir), ...withStubDir(opts.stubDir) });
}

/** 注册主命令 action（-q 单账号 / 多 -q supervisor / 无 -q 读配置 supervisor 拉起）。 */
function registerMainAction(program: Command): void {
    program.action(
        async (opts: { qq?: string[]; dataDir?: string; qqPath?: string; stubDir?: string }) => {
            try {
                await dispatchMainAction(opts);
            } catch (err) {
                handleActionError(err);
            }
        },
    );
}

/** 入口：注册全部子命令与主命令后解析。 */
function main(): void {
    const program = new Command();
    program
        .name("napuketto")
        .version("0.0.1")
        .description("NapukettoQQ 机器人框架（OneBot 11 兼容）");

    program
        .option(
            "-q, --qq <uin>",
            "QQ 号（可重复；多个时 supervisor 拉起多账号子进程）",
            collectQq,
            [],
        )
        .option("-d, --data-dir <dir>", "数据根目录（缺省 <项目根>/.napuketto）")
        .option("--qq-path <path>", "QQ 安装路径（联调覆盖）")
        .option(
            "--stub-dir <dir>",
            "stub QQNT.dll 目录（自建宿主 PATH 前置，缺省 loader/native/stub-test-env，Git Submodule）",
        );

    // 启动字符画（每次 cli 启动、首个 action 前打印；受 [log].banner / NAPUKETTO_NO_BANNER
    // 控制——supervisor 派生的子进程被注入 NO_BANNER，每树至多一次）。preAction 时机
    // 才能拿到已解析的 -d 数据根（banner 决策需读对配置文件）。
    program.hook("preAction", () => {
        const cfg = resolveCliLogConfig(rootDataDir(program).dataDir);
        if (cfg.banner) {
            process.stdout.write(`${BANNER}\n`);
        }
    });

    registerConfigCommands(program);
    registerSupervisorCommand(program);
    registerOpsCommands(program);
    registerMainAction(program);

    program.parse(process.argv);
}

main();
