/**
 * 默认动作（无子命令）用例：-q 单账号 / 多 -q supervisor / 无 -q 读配置拉起全部账号。
 *
 * 从 index.ts 拆出（2026-10-25 模块收拢）：这里只做编排，不 import commander；
 * 参数解析、帮助文案与退出码收敛在 cli/program.ts。
 */
import { loadCliConfigWithSource } from "../config/store.js";
import { runSingleAccount } from "../runtime/boot.js";
import { runSupervisor } from "../runtime/supervisor.js";

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

/** 主命令已解析参数。 */
export interface StartOptions {
    qq?: string[];
    dataDir?: string;
    qqPath?: string;
    stubDir?: string;
}

/** 单账号启动分支（-q 单值；构造 bootOptions 后走 runSingleAccount）。 */
async function runSingleAccountBranch(opts: StartOptions, qqs: string[]): Promise<void> {
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
async function autoStart(opts: StartOptions): Promise<void> {
    const { config } = await loadCliConfigWithSource(withDataDir(opts.dataDir));
    if (config.accounts.length === 0) {
        // parseCliConfig 已强制至少一个，此处防御
        throw new Error("主配置没有账号，请编辑 napuketto.toml 填写 [[accounts]] 段");
    }
    await runSupervisor({ ...withDataDir(opts.dataDir), ...withStubDir(opts.stubDir) });
}

/** 主命令分发：无 -q 读配置 supervisor 拉起 / 单 -q 单账号 / 多 -q supervisor。 */
export async function dispatchMainAction(opts: StartOptions): Promise<void> {
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

/** supervisor 子命令用例（读主配置 accounts 批量拉起；-d 复用主命令 option）。 */
export async function runSupervisorCommand(opts: { dataDir?: string }): Promise<void> {
    await runSupervisor(withDataDir(opts.dataDir));
}
