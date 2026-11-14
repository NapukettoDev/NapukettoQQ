/**
 * 系统状态与维护域动作
 *
 * - set_online_status：status/ext_status/battery_status 见 NapCat 状态表
 *   （在线 10 / 离开 30 / 隐身 40 / 忙碌 50 / Q我吧 60 / 请勿打扰 70 等）
 * - set_diy_online_status：customStatus（faceId/wording/faceType）随
 *   setStatus 一并提交；status 缺省 10（在线）
 * - can_send_image / can_send_record：本地恒 true
 * - clean_cache：cleanCache 回调由装配方注入（boot.cjs 接 kernel
 *   PathWrapper.clearCache），未配置时明确报错（不静默）
 * - bot_exit / set_restart：exit/restart 回调由装配方注入（boot.cjs 接
 *   进程控制），未配置时明确报错；重启缺省退化为退出
 */

import { kernelError } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";

/** 默认在线状态值。 */
const STATUS_ONLINE = 10;

const setOnlineStatusSchema = z.object({
    status: z.number().optional(),
    ext_status: z.number().optional(),
    battery_status: z.number().optional(),
});

const setDiyOnlineStatusSchema = z.object({
    status: z.number().optional(),
    /** 自定义状态文案。 */
    wording: z.string(),
    /** 表情 ID。 */
    face_id: z.string().optional(),
    /** 表情类型。 */
    face_type: z.string().optional(),
});

const canSendImageSchema = z.object({});

const canSendRecordSchema = z.object({});

const cleanCacheSchema = z.object({});

const botExitSchema = z.object({});

/**
 * 系统状态与维护域动作工厂（set_online_status ×2 / can_send ×2 / clean_cache /
 * bot_exit / set_restart）。
 */
export function createSystemStatusActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "set_online_status",
            schema: setOnlineStatusSchema,
            handle: async (payload) => {
                await api.msgApi.setOnlineStatus({
                    status: payload.status ?? STATUS_ONLINE,
                    extStatus: payload.ext_status ?? 0,
                    batteryStatus: payload.battery_status ?? 0,
                });
                return null;
            },
        }),
        defineOb11Action({
            name: "set_diy_online_status",
            schema: setDiyOnlineStatusSchema,
            handle: async (payload) => {
                const customStatus = {
                    faceId: payload.face_id ?? "",
                    wording: payload.wording,
                    faceType: payload.face_type ?? "1",
                };
                await api.msgApi.setOnlineStatus({
                    status: payload.status ?? STATUS_ONLINE,
                    extStatus: 0,
                    batteryStatus: 0,
                    customStatus,
                });
                return null;
            },
        }),
        defineOb11Action({
            name: "can_send_image",
            schema: canSendImageSchema,
            handle: async () => ({ yes: true }),
        }),
        defineOb11Action({
            name: "can_send_record",
            schema: canSendRecordSchema,
            handle: async () => ({ yes: true }),
        }),
        defineOb11Action({
            name: "clean_cache",
            schema: cleanCacheSchema,
            handle: async () => {
                if (api.cleanCache === undefined) {
                    throw kernelError(
                        "clean_cache 未配置（装配方未注入清理回调）",
                        "INVALID_STATE",
                    );
                }
                await api.cleanCache();
                return null;
            },
        }),
        defineOb11Action({
            name: "bot_exit",
            schema: botExitSchema,
            handle: async () => {
                if (api.exit === undefined) {
                    throw kernelError("bot_exit 未配置（装配方未注入退出回调）", "INVALID_STATE");
                }
                await api.exit();
                return null;
            },
        }),
        defineOb11Action({
            name: "set_restart",
            schema: botExitSchema,
            handle: async () => {
                const restart = api.restart ?? api.exit;
                if (restart === undefined) {
                    throw kernelError(
                        "set_restart 未配置（装配方未注入重启回调）",
                        "INVALID_STATE",
                    );
                }
                await restart();
                return null;
            },
        }),
    ];
}
