/**
 * 系统信息域动作（2026-11-14 自 get-login-info / get-version-info / get-status /
 * get-robot-uin-range / translate-en2zh 合并）——只读信息查询，多为本地组装。
 *
 * - get_login_info（P2-4）：self 由装配方注入（P2-5 接 kernel selfInfo 取真实昵称）
 * - get_version_info（P2-11）：appVersion 由装配方注入（kernel wrapper 版本或
 *   NAPUTO_QQ_VERSION）
 * - get_status（P2-11）：返回与心跳 status 同构的 OB11Status（online/good）
 * - get_robot_uin_range（P2-11）：NapCat 从配置返回；这里给通用范围（min/max）
 * - translate_en2zh（P2-14）：kernel RichMediaApi.translateWords（词条数组限长）
 */

import type { RichMediaApi } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import type { OB11Status } from "../../event/index.js";
import type { LoginInfo, VersionInfo } from "../../types/index.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { MAX_TRANSLATE_WORDS } from "../limits.js";

const getLoginInfoSchema = z.object({});

type GetLoginInfoPayload = z.infer<typeof getLoginInfoSchema>;

/** 获取登录信息（self 由装配方注入，P2-5 接 kernel selfInfo 维护后取真实昵称）。 */
export class GetLoginInfoAction extends BaseAction<GetLoginInfoPayload, LoginInfo> {
    readonly name = "get_login_info";
    readonly schema = getLoginInfoSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly self: { uin: string; nickname: string };

    constructor(self: { uin: string; nickname: string }) {
        super();
        this.self = self;
    }

    protected _handle(_payload: GetLoginInfoPayload): Promise<LoginInfo> {
        return Promise.resolve({
            user_id: Number(this.self.uin),
            nickname: this.self.nickname,
        });
    }
}

const getVersionInfoSchema = z.object({});

type GetVersionInfoPayload = z.infer<typeof getVersionInfoSchema>;

/** get_version_info 依赖（appVersion 由装配方注入，OneBotApi 视图）。 */
export type GetVersionInfoDeps = Pick<OneBotApi, "appVersion">;

/** 获取版本信息（本地组装，P2-11）。 */
export class GetVersionInfoAction extends BaseAction<GetVersionInfoPayload, VersionInfo> {
    readonly name = "get_version_info";
    readonly schema = getVersionInfoSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: GetVersionInfoDeps;

    constructor(deps: GetVersionInfoDeps) {
        super();
        this.deps = deps;
    }

    protected _handle(_payload: GetVersionInfoPayload): Promise<VersionInfo> {
        return Promise.resolve({
            app_name: "napuketto-qq",
            app_version: this.deps.appVersion,
            protocol_version: "v11",
        });
    }
}

const getStatusSchema = z.object({});

type GetStatusPayload = z.infer<typeof getStatusSchema>;

/** 获取运行状态（本地组装，P2-11）。 */
export class GetStatusAction extends BaseAction<GetStatusPayload, OB11Status> {
    readonly name = "get_status";
    readonly schema = getStatusSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    protected _handle(_payload: GetStatusPayload): Promise<OB11Status> {
        return Promise.resolve({
            online: true,
            good: true,
        });
    }
}

const getRobotUinRangeSchema = z.object({});

type GetRobotUinRangePayload = z.infer<typeof getRobotUinRangeSchema>;

/** QQ 号下限。 */
const UIN_MIN = 10_001;
/** QQ 号上限。 */
const UIN_MAX = 4_294_967_295;

/** 获取机器人 QQ 号范围（P2-11 本地组装）。 */
export class GetRobotUinRangeAction extends BaseAction<
    GetRobotUinRangePayload,
    { min: number; max: number }
> {
    readonly name = "get_robot_uin_range";
    readonly schema = getRobotUinRangeSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    protected _handle(_payload: GetRobotUinRangePayload): Promise<{ min: number; max: number }> {
        return Promise.resolve({ min: UIN_MIN, max: UIN_MAX });
    }
}

const translateEn2ZhSchema = z.object({
    // 上界见 action/limits.ts：第三方可直接 POST，词条数组不能无界
    words: z.array(z.string()).max(MAX_TRANSLATE_WORDS),
});

type TranslateEn2ZhPayload = z.infer<typeof translateEn2ZhSchema>;

/** 英文单词翻译（P2-14）。 */
export class TranslateEn2ZhAction extends BaseAction<TranslateEn2ZhPayload, { words: string[] }> {
    readonly name = "translate_en2zh";
    readonly schema = translateEn2ZhSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: TranslateEn2ZhPayload): Promise<{ words: string[] }> {
        const words = await this.richMediaApi.translateWords(payload.words);
        return { words };
    }
}

/**
 * 系统信息域动作工厂（login_info / version_info / status / robot_uin_range /
 * translate_en2zh）。
 */
export function createSystemInfoActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new GetLoginInfoAction(api.self),
        new GetVersionInfoAction(api),
        new GetStatusAction(),
        new GetRobotUinRangeAction(),
        new TranslateEn2ZhAction(api.richMediaApi),
    ];
}
