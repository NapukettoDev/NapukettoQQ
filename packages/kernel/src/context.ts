/**
 * CoreContext：只读装配根（ADR-015 推论，无全局单例）
 *
 * 把 logger / paths / wrapper 上下文聚合成单一装配根，由装配层（NapukettoCore）
 * 创建并传递给消费方（协议层 adapter、apis、cache）。
 *
 * - 无全局单例：每账号每进程一份，多账号多进程场景天然隔离（ADR-015）。
 * - 只读消费：字段由装配层填充，消费方只读，不直接修改。
 */
import type pino from "pino";
import type { PathWrapper } from "./infra/index.js";
import type { LoginResult } from "./login/index.js";
import type { WrapperContext } from "./wrapper/lifecycle.js";

export interface CoreContextOptions {
    /** pino logger（console + 可选文件，由装配层创建）。 */
    logger: pino.Logger;
    /** 账号数据目录布局（config/logs/cache）。 */
    paths: PathWrapper;
}

/**
 * 装配根：持有进程级共享对象。
 * wrapper / login 由 NapukettoCore 装配后填充，未装配前为 null。
 */
export interface CoreContext {
    readonly logger: pino.Logger;
    readonly paths: PathWrapper;
    /** QQ wrapper 上下文（attachWrapper 后填充）。 */
    wrapper: WrapperContext | null;
    /** 登录结果（login 成功后填充）。 */
    login: LoginResult | null;
}

/** 创建装配根（初始 wrapper/login 为 null）。 */
export function createCoreContext(opts: CoreContextOptions): CoreContext {
    return {
        logger: opts.logger,
        paths: opts.paths,
        wrapper: null,
        login: null,
    };
}
