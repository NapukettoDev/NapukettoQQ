/**
 * commander 装配层：全局选项、banner、子命令注册、默认动作分发。
 *
 * 从 index.ts 拆出（2026-10-25 模块收拢）：只做 CLI 契约适配（参数/帮助/输出/
 * 退出码），用例实现见 commands/。禁止在此写业务逻辑。
 */
import process from "node:process";
import { resolveDataRoot } from "@napuketto/kernel";
import { Command } from "commander";
import {
    cmdConfigApply,
    cmdConfigInit,
    cmdConfigList,
    cmdConfigValidate,
} from "../commands/config.js";
import { cmdRestart, cmdStatus, cmdStop } from "../commands/ops.js";
import { dispatchMainAction, runSupervisorCommand } from "../commands/start.js";
import { resolveCliLogConfig } from "../logger.js";
import { handleActionError } from "./error.js";

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

/** 读主命令已解析的 data-dir（-d 定义在主命令，子命令经此共享）。 */
function rootDataDir(program: Command): { dataDir?: string } {
    const { dataDir } = program.opts<{ dataDir?: string }>();
    return dataDir === undefined ? {} : { dataDir };
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
                await runSupervisorCommand(rootDataDir(program));
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
export function main(): void {
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
