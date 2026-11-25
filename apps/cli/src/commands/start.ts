/**
 * 默认动作（无子命令）用例：-q 单账号 / 多 -q supervisor / 无 -q 读配置拉起全部账号。
 * 这里只做编排，不 import commander；参数解析、帮助文案与退出码收敛在 cli/program.ts。
 */
import { configError } from "@napuketto/kernel";
import { parseCliQq } from "../config/schema.js";
import { loadCliConfigWithSource } from "../config/store.js";
import { logger } from "../logger.js";
import { runSingleAccount } from "../runtime/boot.js";
import { runSupervisor } from "../runtime/supervisor.js";

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
        ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
        ...(opts.qqPath === undefined ? {} : { qqPath: opts.qqPath }),
        ...(opts.stubDir === undefined ? {} : { stubDir: opts.stubDir }),
    });
}

/** 无 -q 时：读全局配置 accounts（账号必填），supervisor 拉起全部启用账号；缺账号直接报错提示编辑模板。
 * 配置加载内联优先（NAPUKETTO_CONFIG_JSON > 文件）；校验失败 ConfigError → exit 78。 */
async function autoStart(opts: StartOptions): Promise<void> {
    const { config } = await loadCliConfigWithSource({
        ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
        // 日志经回调注入：store 不反向 import logger（config <-> logger 解耦）
        onInfo: (obj, msg) => logger.info(obj, msg),
    });
    if (config.accounts.length === 0) {
        // parseCliConfig 已强制至少一个，此处防御（退出码 78 配置未就绪契约）
        throw configError("主配置没有账号，请编辑 napuketto.toml 填写 [[accounts]] 段");
    }
    await runSupervisor({
        ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
        ...(opts.stubDir === undefined ? {} : { stubDir: opts.stubDir }),
        ...(opts.qqPath === undefined ? {} : { qqPath: opts.qqPath }),
    });
}

/**
 * -q 列表入口校验：格式/占位值复用主配置规则，重复值直接报错。
 * ConfigError → exit 78；放在分发最前，非法值不会进入数据目录拼接或 supervisor。
 */
function parseQqList(qqs: string[]): string[] {
    const seen = new Set<string>();
    for (const qq of qqs) {
        parseCliQq(qq);
        if (seen.has(qq)) {
            throw configError(`-q/--qq 重复指定账号: "${qq}"（每个账号只能出现一次）`);
        }
        seen.add(qq);
    }
    return qqs;
}

/** 主命令分发：无 -q 读配置 supervisor 拉起 / 单 -q 单账号 / 多 -q supervisor。 */
export async function dispatchMainAction(opts: StartOptions): Promise<void> {
    const qqs = parseQqList(opts.qq ?? []);
    if (qqs.length === 0) {
        await autoStart(opts);
        return;
    }
    if (qqs.length === 1) {
        await runSingleAccountBranch(opts, qqs);
        return;
    }
    await runSupervisor({
        qqs,
        ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
        ...(opts.stubDir === undefined ? {} : { stubDir: opts.stubDir }),
        ...(opts.qqPath === undefined ? {} : { qqPath: opts.qqPath }),
    });
}

/** supervisor 子命令用例（读主配置 accounts 批量拉起；-d / --qq-path 复用主命令 option）。 */
export async function runSupervisorCommand(opts: {
    dataDir?: string;
    qqPath?: string;
}): Promise<void> {
    await runSupervisor({
        ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
        ...(opts.qqPath === undefined ? {} : { qqPath: opts.qqPath }),
    });
}
