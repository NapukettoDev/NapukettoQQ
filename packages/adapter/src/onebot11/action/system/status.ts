/**
 * 系统状态与维护域动作（2026-11-14 自 set-online-status / set-diy-online-status /
 * can-send-image / can-send-record / clean-cache / process-control 合并）
 *
 * - set_online_status（P2-12）：status/ext_status/battery_status 见 NapCat 状态表
 *   （在线 10 / 离开 30 / 隐身 40 / 忙碌 50 / Q我吧 60 / 请勿打扰 70 等）
 * - set_diy_online_status（P2-12）：customStatus（faceId/wording/faceType）随
 *   setStatus 一并提交；status 缺省 10（在线）
 * - can_send_image / can_send_record（P2-11）：本地恒 true
 * - clean_cache（P2-11）：cleanCache 回调由装配方注入（boot.cjs 接 kernel
 *   PathWrapper.clearCache），未配置时明确报错（不静默）
 * - bot_exit / set_restart（P2-12）：exit/restart 回调由装配方注入（boot.cjs 接
 *   进程控制），未配置时明确报错；重启缺省退化为退出
 */

import { kernelError, type MsgApi } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { ob11ErrorCodeMap } from "../error-map.js";

const setOnlineStatusSchema = z.object({
    status: z.number().optional(),
    ext_status: z.number().optional(),
    battery_status: z.number().optional(),
});

type SetOnlineStatusPayload = z.infer<typeof setOnlineStatusSchema>;

/** 默认在线状态值。 */
const STATUS_ONLINE = 10;

/** 设置在线状态（P2-12 接 kernel setOnlineStatus）。 */
export class SetOnlineStatusAction extends BaseAction<SetOnlineStatusPayload, null> {
    readonly name = "set_online_status";
    readonly schema = setOnlineStatusSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly msgApi: MsgApi;

    constructor(msgApi: MsgApi) {
        super();
        this.msgApi = msgApi;
    }

    protected async _handle(payload: SetOnlineStatusPayload): Promise<null> {
        await this.msgApi.setOnlineStatus({
            status: payload.status ?? STATUS_ONLINE,
            extStatus: payload.ext_status ?? 0,
            batteryStatus: payload.battery_status ?? 0,
        });
        return null;
    }
}

const setDiyOnlineStatusSchema = z.object({
    status: z.number().optional(),
    /** 自定义状态文案。 */
    wording: z.string(),
    /** 表情 ID。 */
    face_id: z.string().optional(),
    /** 表情类型。 */
    face_type: z.string().optional(),
});

type SetDiyOnlineStatusPayload = z.infer<typeof setDiyOnlineStatusSchema>;

/** 设置自定义在线状态（P2-12 接 kernel setOnlineStatus customStatus）。 */
export class SetDiyOnlineStatusAction extends BaseAction<SetDiyOnlineStatusPayload, null> {
    readonly name = "set_diy_online_status";
    readonly schema = setDiyOnlineStatusSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly msgApi: MsgApi;

    constructor(msgApi: MsgApi) {
        super();
        this.msgApi = msgApi;
    }

    protected async _handle(payload: SetDiyOnlineStatusPayload): Promise<null> {
        const customStatus = {
            faceId: payload.face_id ?? "",
            wording: payload.wording,
            faceType: payload.face_type ?? "1",
        };
        await this.msgApi.setOnlineStatus({
            status: payload.status ?? STATUS_ONLINE,
            extStatus: 0,
            batteryStatus: 0,
            customStatus,
        });
        return null;
    }
}

const canSendImageSchema = z.object({});

type CanSendImagePayload = z.infer<typeof canSendImageSchema>;

/** 是否可以发送图片（本地 true，P2-11）。 */
export class CanSendImageAction extends BaseAction<CanSendImagePayload, { yes: boolean }> {
    readonly name = "can_send_image";
    readonly schema = canSendImageSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    protected _handle(_payload: CanSendImagePayload): Promise<{ yes: boolean }> {
        return Promise.resolve({ yes: true });
    }
}

const canSendRecordSchema = z.object({});

type CanSendRecordPayload = z.infer<typeof canSendRecordSchema>;

/** 是否可以发送语音（本地 true，P2-11）。 */
export class CanSendRecordAction extends BaseAction<CanSendRecordPayload, { yes: boolean }> {
    readonly name = "can_send_record";
    readonly schema = canSendRecordSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    protected _handle(_payload: CanSendRecordPayload): Promise<{ yes: boolean }> {
        return Promise.resolve({ yes: true });
    }
}

const cleanCacheSchema = z.object({});

type CleanCachePayload = z.infer<typeof cleanCacheSchema>;

/** clean_cache 依赖（cleanCache 回调由装配方注入，OneBotApi 视图）。 */
export type CleanCacheDeps = Pick<OneBotApi, "cleanCache">;

/** 清理缓存（P2-11）。 */
export class CleanCacheAction extends BaseAction<CleanCachePayload, null> {
    readonly name = "clean_cache";
    readonly schema = cleanCacheSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: CleanCacheDeps;

    constructor(deps: CleanCacheDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(_payload: CleanCachePayload): Promise<null> {
        if (this.deps.cleanCache === undefined) {
            throw kernelError("clean_cache 未配置（装配方未注入清理回调）", "INVALID_STATE");
        }
        await this.deps.cleanCache();
        return null;
    }
}

const botExitSchema = z.object({});

type BotExitPayload = z.infer<typeof botExitSchema>;

/** 退出/重启依赖（回调由装配方注入，OneBotApi 视图）。 */
export type ProcessControlDeps = Pick<OneBotApi, "exit" | "restart">;

/** 退出机器人进程（P2-12）。 */
export class BotExitAction extends BaseAction<BotExitPayload, null> {
    readonly name = "bot_exit";
    readonly schema = botExitSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: ProcessControlDeps;

    constructor(deps: ProcessControlDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(_payload: BotExitPayload): Promise<null> {
        if (this.deps.exit === undefined) {
            throw kernelError("bot_exit 未配置（装配方未注入退出回调）", "INVALID_STATE");
        }
        await this.deps.exit();
        return null;
    }
}

/** 重启机器人（P2-12；重启交给装配方，缺省退化为退出）。 */
export class SetRestartAction extends BaseAction<BotExitPayload, null> {
    readonly name = "set_restart";
    readonly schema = botExitSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly deps: ProcessControlDeps;

    constructor(deps: ProcessControlDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(_payload: BotExitPayload): Promise<null> {
        const restart = this.deps.restart ?? this.deps.exit;
        if (restart === undefined) {
            throw kernelError("set_restart 未配置（装配方未注入重启回调）", "INVALID_STATE");
        }
        await restart();
        return null;
    }
}

/**
 * 系统状态与维护域动作工厂（set_online_status ×2 / can_send ×2 / clean_cache /
 * bot_exit / set_restart）。
 */
export function createSystemStatusActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new SetOnlineStatusAction(api.msgApi),
        new SetDiyOnlineStatusAction(api.msgApi),
        new CanSendImageAction(),
        new CanSendRecordAction(),
        new CleanCacheAction(api),
        new BotExitAction(api),
        new SetRestartAction(api),
    ];
}
