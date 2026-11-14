/**
 * 系统信息域动作——只读信息查询，多为本地组装。
 *
 * - get_login_info：self 由装配方注入（接 kernel selfInfo 取真实昵称）
 * - get_version_info：appVersion 由装配方注入（kernel wrapper 版本或
 *   NAPUTO_QQ_VERSION）
 * - get_status：返回与心跳 status 同构的 OB11Status（online/good）
 * - get_robot_uin_range：NapCat 从配置返回；这里给通用范围（min/max）
 * - translate_en2zh：kernel RichMediaApi.translateWords（词条数组限长）
 */

import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import type { OB11Status } from "../../event/index.js";
import type { LoginInfo, VersionInfo } from "../../types/index.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";
import { MAX_TRANSLATE_WORDS } from "../limits.js";

/** QQ 号下限。 */
const UIN_MIN = 10_001;
/** QQ 号上限。 */
const UIN_MAX = 4_294_967_295;

const getLoginInfoSchema = z.object({});

const getVersionInfoSchema = z.object({});

const getStatusSchema = z.object({});

const getRobotUinRangeSchema = z.object({});

const translateEn2ZhSchema = z.object({
    // 上界见 action/limits.ts：第三方可直接 POST，词条数组不能无界
    words: z.array(z.string()).max(MAX_TRANSLATE_WORDS),
});

/**
 * 系统信息域动作工厂（login_info / version_info / status / robot_uin_range /
 * translate_en2zh）。
 */
export function createSystemInfoActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "get_login_info",
            schema: getLoginInfoSchema,
            handle: (): Promise<LoginInfo> =>
                Promise.resolve({
                    user_id: Number(api.self.uin),
                    nickname: api.self.nickname,
                }),
        }),
        defineOb11Action({
            name: "get_version_info",
            schema: getVersionInfoSchema,
            handle: (): Promise<VersionInfo> =>
                Promise.resolve({
                    app_name: "napuketto-qq",
                    app_version: api.appVersion,
                    protocol_version: "v11",
                }),
        }),
        defineOb11Action({
            name: "get_status",
            schema: getStatusSchema,
            handle: (): Promise<OB11Status> =>
                Promise.resolve({
                    online: true,
                    good: true,
                }),
        }),
        defineOb11Action({
            name: "get_robot_uin_range",
            schema: getRobotUinRangeSchema,
            handle: (): Promise<{ min: number; max: number }> =>
                Promise.resolve({ min: UIN_MIN, max: UIN_MAX }),
        }),
        defineOb11Action({
            name: "translate_en2zh",
            schema: translateEn2ZhSchema,
            handle: async (payload) => {
                const words = await api.richMediaApi.translateWords(payload.words);
                return { words };
            },
        }),
    ];
}
