/**
 * 群精华/荣誉域动作（2026-11-14 自 set-essence-msg / delete-essence-msg /
 * get-essence-msg-list / get-group-honor-info 合并）
 *
 * - set/delete_essence_msg（P2-10）：message_id → msgId + peer（MessageUnique 反查，
 *   需群消息）→ GroupApi.addGroupEssence / removeGroupEssence（共用 EssenceMsgBase）
 * - get_essence_msg_list（P2-15）：qun.qq.com digest_list web 接口 → msg_list，
 *   msg_content 映射 text/image 段
 * - get_group_honor_info（P2-15）：qun.qq.com honorlist web 接口；type 缺省 all
 */

import {
    ChatType,
    type GroupHonorWebInfo,
    kernelError,
    type WebApi,
    WebHonorType,
} from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { resolveMsgIdAndPeer } from "../../helper/message-unique.js";
import type { OB11MessageSegment } from "../../types/index.js";
import { ob11ErrorCodeMap } from "../error-map.js";

const setEssenceMsgSchema = z.object({
    message_id: z.union([z.number(), z.string()]),
});

/** 精华消息依赖（OneBotApi 视图，由装配方注入）。 */
export type EssenceMsgDeps = Pick<OneBotApi, "groupApi" | "messageUnique">;

/** 精华消息基类（set/delete 共用实现，2026-08-08 克隆合并）。 */
export abstract class EssenceMsgBase extends BaseAction<{ message_id: number | string }, null> {
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    protected readonly deps: EssenceMsgDeps;

    constructor(deps: EssenceMsgDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(payload: { message_id: number | string }): Promise<null> {
        const { msgId, peer } = resolveMsgIdAndPeer(payload.message_id, this.deps.messageUnique);
        if (peer.chatType !== ChatType.GROUP) {
            throw kernelError("精华消息仅支持群聊消息", "INVALID_PARAM");
        }
        await this.operate(peer.peerUid, msgId);
        return null;
    }

    /** 具体精华操作（子类实现：addGroupEssence / removeGroupEssence）。 */
    protected abstract operate(groupCode: string, msgId: string): Promise<void>;
}

/** 设置精华消息（P2-10 接 kernel addGroupEssence）。 */
export class SetEssenceMsgAction extends EssenceMsgBase {
    readonly name = "set_essence_msg";
    readonly schema = setEssenceMsgSchema;

    protected async operate(groupCode: string, msgId: string): Promise<void> {
        await this.deps.groupApi.addGroupEssence(groupCode, msgId);
    }
}

const deleteEssenceMsgSchema = z.object({
    message_id: z.union([z.number(), z.string()]),
});

/** 取消精华消息（P2-10 接 kernel removeGroupEssence）。 */
export class DeleteEssenceMsgAction extends EssenceMsgBase {
    readonly name = "delete_essence_msg";
    readonly schema = deleteEssenceMsgSchema;

    protected async operate(groupCode: string, msgId: string): Promise<void> {
        await this.deps.groupApi.removeGroupEssence(groupCode, msgId);
    }
}

const getEssenceMsgListSchema = z.object({
    group_id: z.number(),
});

type GetEssenceMsgListPayload = z.infer<typeof getEssenceMsgListSchema>;

/** 文本段类型（msg_content.msg_type）。 */
const MSG_TYPE_TEXT = 1;
/** 图片段类型（msg_content.msg_type）。 */
const MSG_TYPE_IMAGE = 3;

/** 精华消息项 OB11 结构。 */
export interface EssenceMsgInfo {
    msg_seq: number;
    msg_random: number;
    sender_id: number;
    sender_nick: string;
    operator_id: number;
    operator_nick: string;
    operator_time: number;
    message_id: number;
    content: OB11MessageSegment[];
}

/** 获取群精华消息列表（P2-15 接 kernel WebApi）。 */
export class GetEssenceMsgListAction extends BaseAction<
    GetEssenceMsgListPayload,
    EssenceMsgInfo[]
> {
    readonly name = "get_essence_msg_list";
    readonly schema = getEssenceMsgListSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly webApi: WebApi;

    constructor(webApi: WebApi) {
        super();
        this.webApi = webApi;
    }

    protected async _handle(payload: GetEssenceMsgListPayload): Promise<EssenceMsgInfo[]> {
        const list = await this.webApi.getEssenceMsgList(String(payload.group_id));
        const out: EssenceMsgInfo[] = [];
        for (const item of list) {
            const content: OB11MessageSegment[] = [];
            for (const part of item.msg_content ?? []) {
                const seg = toSegment(part);
                if (seg !== null) {
                    content.push(seg);
                }
            }
            out.push({
                msg_seq: item.msg_seq,
                msg_random: item.msg_random,
                sender_id: Number(item.sender_uin),
                sender_nick: item.sender_nick,
                operator_id: Number(item.add_digest_uin),
                operator_nick: item.add_digest_nick,
                operator_time: item.add_digest_time,
                message_id: 0,
                content,
            });
        }
        return out;
    }
}

/** msg_content 项 → OB11 段（1=text 3=image，纯函数）。 */
function toSegment(part: {
    msg_type?: number;
    text?: string;
    image_url?: string;
}): OB11MessageSegment | null {
    if (part.msg_type === MSG_TYPE_TEXT) {
        return { type: "text", data: { text: part.text ?? "" } };
    }
    if (part.msg_type === MSG_TYPE_IMAGE) {
        return { type: "image", data: { file: part.image_url ?? "" } };
    }
    return null;
}

const getGroupHonorInfoSchema = z.object({
    group_id: z.number(),
    type: z.string().optional(),
});

type GetGroupHonorInfoPayload = z.infer<typeof getGroupHonorInfoSchema>;

/** 获取群荣誉信息（P2-15 接 kernel WebApi）。 */
export class GetGroupHonorInfoAction extends BaseAction<
    GetGroupHonorInfoPayload,
    GroupHonorWebInfo
> {
    readonly name = "get_group_honor_info";
    readonly schema = getGroupHonorInfoSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly webApi: WebApi;

    constructor(webApi: WebApi) {
        super();
        this.webApi = webApi;
    }

    protected _handle(payload: GetGroupHonorInfoPayload): Promise<GroupHonorWebInfo> {
        const type = mapHonorType(payload.type);
        return this.webApi.getGroupHonorInfo(String(payload.group_id), type);
    }
}

/** type 字符串 → WebHonorType（talkative/performer/legend/emotion/all，纯函数）。 */
function mapHonorType(raw: string | undefined): WebHonorType {
    if (raw === "talkative") {
        return WebHonorType.TALKATIVE;
    }
    if (raw === "performer") {
        return WebHonorType.PERFORMER;
    }
    if (raw === "legend") {
        return WebHonorType.LEGEND;
    }
    if (raw === "emotion") {
        return WebHonorType.EMOTION;
    }
    return WebHonorType.ALL;
}

/** 群精华/荣誉域动作工厂（set/delete_essence_msg / essence_msg_list / honor_info）。 */
export function createGroupEssenceActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new SetEssenceMsgAction(api),
        new DeleteEssenceMsgAction(api),
        new GetEssenceMsgListAction(api.webApi),
        new GetGroupHonorInfoAction(api.webApi),
    ];
}
