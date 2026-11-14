/**
 * 群精华/荣誉域动作
 *
 * - set/delete_essence_msg：message_id → msgId + peer（MessageUnique 反查，
 *   需群消息）→ GroupApi.addGroupEssence / removeGroupEssence（共用实现）
 * - get_essence_msg_list：qun.qq.com digest_list web 接口 → msg_list，
 *   msg_content 映射 text/image 段
 * - get_group_honor_info：qun.qq.com honorlist web 接口；type 缺省 all
 */
import { ChatType, type GroupHonorWebInfo, kernelError, WebHonorType } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { resolveMsgIdAndPeer } from "../../helper/message-unique.js";
import type { OB11MessageSegment } from "../../types/index.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";

/** 文本段类型（msg_content.msg_type）。 */
const MSG_TYPE_TEXT = 1;
/** 图片段类型（msg_content.msg_type）。 */
const MSG_TYPE_IMAGE = 3;

/** 精华消息项 OB11 结构。 */
interface EssenceMsgInfo {
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

/** set/delete 精华共用实现：message_id 反查 + 群聊校验 + 具体精华操作。 */
async function operateEssence(
    api: OneBotApi,
    messageId: number | string,
    operate: (groupCode: string, msgId: string) => Promise<void>,
): Promise<null> {
    const { msgId, peer } = resolveMsgIdAndPeer(messageId, api.messageUnique);
    if (peer.chatType !== ChatType.GROUP) {
        throw kernelError("精华消息仅支持群聊消息", "INVALID_PARAM");
    }
    await operate(peer.peerUid, msgId);
    return null;
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
export function createGroupEssenceActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "set_essence_msg",
            schema: z.object({ message_id: z.union([z.number(), z.string()]) }),
            handle: (payload) =>
                operateEssence(api, payload.message_id, (groupCode, msgId) =>
                    api.groupApi.addGroupEssence(groupCode, msgId),
                ),
        }),
        defineOb11Action({
            name: "delete_essence_msg",
            schema: z.object({ message_id: z.union([z.number(), z.string()]) }),
            handle: (payload) =>
                operateEssence(api, payload.message_id, (groupCode, msgId) =>
                    api.groupApi.removeGroupEssence(groupCode, msgId),
                ),
        }),
        defineOb11Action({
            name: "get_essence_msg_list",
            schema: z.object({ group_id: z.number() }),
            handle: async (payload): Promise<EssenceMsgInfo[]> => {
                const list = await api.webApi.getEssenceMsgList(String(payload.group_id));
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
            },
        }),
        defineOb11Action({
            name: "get_group_honor_info",
            schema: z.object({
                group_id: z.number(),
                type: z.string().optional(),
            }),
            handle: (payload): Promise<GroupHonorWebInfo> =>
                api.webApi.getGroupHonorInfo(String(payload.group_id), mapHonorType(payload.type)),
        }),
    ];
}
