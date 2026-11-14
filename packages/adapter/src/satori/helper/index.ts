/**
 * Satori helper 层公共出口
 *
 * 配置 schema（config）+ 错误映射（error）+ ID 翻译（ids）+
 * 消息翻译（translate）。element/ 为消息元素子域，translate 直接引用其模块。
 */
export type { SatoriConfig } from "./config.js";
export { satoriConfigSchema } from "./config.js";
export { HTTP_STATUS, satoriHttpStatusMap } from "./error.js";
export {
    ADAPTER,
    FEATURES,
    PLATFORM,
    toDirectChannel,
    toGroupChannel,
    toGuild,
    toLogin,
    toMinimalLogin,
    toUser,
} from "./ids.js";
export type { SatoriTranslateDeps } from "./translate.js";
export { toChannelById, toSatoriMessage } from "./translate.js";
