/**
 * Milky 消息查询域动作：get_message / get_history_messages / get_forwarded_messages。
 * 入口是 message_seq（Milky ID 模型），经 seqIndex 反查 msgId；
 * get_forwarded_messages 经 seqIndex 转发索引（resId → peer）定位。
 */
import type { GroupDetailInfo, GroupMember, Peer, RawMessage } from "@napuketto/kernel";
import { ChatType, kernelError, toCanonicalElements } from "@napuketto/kernel";
import { z } from "zod";
import { toUnixSeconds } from "../../shared/raw-message.js";
import type { MilkyApi } from "../api.js";
import { type ReceiveTranslateContext, toMessageReceiveEvent } from "../helper/event/translate.js";
import { toGroupEntity, toGroupMemberEntity } from "../helper/message/entities.js";
import { canonicalToIncomingSegments, incomingForwardSegment } from "../helper/message/segments.js";
import type {
    GetForwardedMessagesOutput,
    GetHistoryMessagesOutput,
    GetMessageOutput,
    IncomingForwardedMessage,
    IncomingMessage,
    IncomingSegment,
    MessageScene,
} from "../types.js";
import { defineMilkyAction, type MilkyAction } from "./base-action.js";

/** get_message / mark_message_as_read 共入参（场景 + 对端 + seq）。 */
export const peerMessageFields = {
    message_scene: z.enum(["friend", "group", "temp"]),
    peer_id: z.number().int().min(10001),
    message_seq: z.number().int().min(0),
} as const;

/** 历史消息默认条数（规范 default 20）。 */
const HISTORY_DEFAULT_LIMIT = 20;

/** 消息查询域动作工厂（get_message / get_history_messages / get_forwarded_messages）。 */
export function createMessageQueryActions(api: MilkyApi): MilkyAction[] {
    return [
        defineMilkyAction({
            name: "get_message",
            schema: z.object({ ...peerMessageFields }),
            handle: async (payload: {
                message_scene: MessageScene;
                peer_id: number;
                message_seq: number;
            }): Promise<GetMessageOutput> => {
                const peer = await api.resolvePeer(payload.message_scene, payload.peer_id);
                const msgId = await api.resolveMsgIdBySeq(peer, payload.message_seq, peer.chatType);
                if (msgId === undefined) {
                    throw kernelError(`消息 ${payload.message_seq} 不存在`, "NOT_FOUND");
                }
                const [msg] = await api.msgApi.fetchMsgsByMsgId(peer, [msgId]);
                if (msg === undefined) {
                    throw kernelError(`消息 ${payload.message_seq} 不存在`, "NOT_FOUND");
                }
                return {
                    message: await translateWithEntities(api, payload.message_scene, peer, msg),
                };
            },
        }),
        defineMilkyAction({
            name: "get_history_messages",
            schema: z.object({
                message_scene: z.enum(["friend", "group", "temp"]),
                peer_id: z.number().int().min(10001),
                start_message_seq: z.number().int().min(0).nullable().optional(),
                limit: z.number().int().min(0).nullable().optional(),
            }),
            handle: async (payload: {
                message_scene: MessageScene;
                peer_id: number;
                start_message_seq?: number | null | undefined;
                limit?: number | null | undefined;
            }): Promise<GetHistoryMessagesOutput> => {
                const limit = payload.limit ?? HISTORY_DEFAULT_LIMIT;
                const peer = await api.resolvePeer(payload.message_scene, payload.peer_id);
                const anchor = await resolveAnchor(api, peer, payload.start_message_seq);
                const msgs = await api.msgApi.fetchMessages(peer, {
                    count: limit,
                    ...(anchor !== undefined ? { msgId: anchor } : {}),
                });
                for (const m of msgs) {
                    api.seqIndex.record(m);
                }
                // 群场景实体回填一次（群详情 + 整群成员表），避免逐消息回填
                const groupData =
                    payload.message_scene === "group"
                        ? await loadGroupData(api, peer.peerUid)
                        : null;
                // 原生新→旧，规范要求 seq 升序 → 反转
                const ordered = [...msgs].reverse();
                const messages = ordered.map((m) =>
                    translateHistoryMessage(api, m, peer.peerUid, groupData),
                );
                const hasMore = msgs.length >= limit;
                const oldest = ordered[0];
                return {
                    messages,
                    next_message_seq:
                        hasMore && oldest !== undefined ? Number(oldest.msgSeq) : null,
                };
            },
        }),
        defineMilkyAction({
            name: "get_forwarded_messages",
            schema: z.object({ forward_id: z.string().min(1) }),
            handle: async (payload: {
                forward_id: string;
            }): Promise<GetForwardedMessagesOutput> => {
                const entry = api.seqIndex.resolveForward(payload.forward_id);
                if (entry === undefined) {
                    throw kernelError(
                        `转发消息 ${payload.forward_id} 不存在（未登记）`,
                        "NOT_FOUND",
                    );
                }
                const peer: Peer = { chatType: entry.chatType, peerUid: entry.peerUid };
                const msgs = await api.msgApi.fetchForwardMessage(peer, entry.msgId);
                for (const m of msgs) {
                    api.seqIndex.record(m);
                }
                const uidToUin = await collectUidToUin(api, msgs);
                const messages: IncomingForwardedMessage[] = [];
                for (const m of msgs) {
                    messages.push({
                        message_seq: Number(m.msgSeq),
                        sender_name: await senderNameOf(api, m),
                        avatar_url: avatarUrlOf(m.senderUin),
                        time: toUnixSeconds(m.msgTime),
                        segments: receiveSegmentsOf(m, uidToUin),
                    });
                }
                return { messages };
            },
        }),
    ];
}

/** ---------- 内部辅助 ---------- */

/** 实体回填（group 场景 schema 要求完整实体）→ IncomingMessage。 */
async function translateWithEntities(
    api: MilkyApi,
    scene: MessageScene,
    peer: Peer,
    msg: RawMessage,
): Promise<IncomingMessage> {
    const ctx: ReceiveTranslateContext = { selfUin: api.self.uin };
    if (scene === "group") {
        const [detail, member] = await Promise.all([
            api.groupCache?.getGroupDetail(peer.peerUid).catch((err) => {
                api.logger?.warn(
                    {
                        group: peer.peerUid,
                        error: err instanceof Error ? err.message : String(err),
                    },
                    "milky: 群详情缓存读取失败，实体回填退化",
                );
                return undefined;
            }),
            api.groupCache?.getMember(peer.peerUid, msg.senderUid).catch((err) => {
                api.logger?.debug(
                    {
                        group: peer.peerUid,
                        member: msg.senderUid,
                        error: err instanceof Error ? err.message : String(err),
                    },
                    "milky: 群成员缓存读取失败，实体回填退化",
                );
                return undefined;
            }),
        ]);
        ctx.groupEntity = toGroupEntity(detail, peer.peerUid);
        ctx.groupMemberEntity = toGroupMemberEntity(member, peer.peerUid, msg.senderUin);
    }
    return toMessageReceiveEvent(msg, ctx).data;
}

/** start_message_seq → 锚点 msgId（给了 seq 却反查不到 = NOT_FOUND）。 */
async function resolveAnchor(
    api: MilkyApi,
    peer: Peer,
    startSeq: number | null | undefined,
): Promise<string | undefined> {
    if (startSeq === undefined || startSeq === null) {
        return undefined;
    }
    const msgId = await api.resolveMsgIdBySeq(peer, startSeq, peer.chatType);
    if (msgId === undefined) {
        throw kernelError(`起始消息 ${startSeq} 不存在`, "NOT_FOUND");
    }
    return msgId;
}

/** 群场景回填数据（详情 + 成员表；缓存未装配返回空数据）。 */
async function loadGroupData(
    api: MilkyApi,
    groupCode: string,
): Promise<{ detail: GroupDetailInfo | undefined; members: Map<string, GroupMember> }> {
    if (api.groupCache === undefined) {
        return { detail: undefined, members: new Map() };
    }
    const [detail, members] = await Promise.all([
        api.groupCache.getGroupDetail(groupCode).catch((err) => {
            api.logger?.warn(
                { group: groupCode, error: err instanceof Error ? err.message : String(err) },
                "milky: 群详情缓存读取失败，历史翻译退化",
            );
            return undefined;
        }),
        api.groupCache.getMembers(groupCode).catch((err) => {
            api.logger?.warn(
                { group: groupCode, error: err instanceof Error ? err.message : String(err) },
                "milky: 群成员表缓存读取失败，历史翻译退化",
            );
            return [] as GroupMember[];
        }),
    ]);
    const memberByUid = new Map<string, GroupMember>();
    for (const m of members) {
        memberByUid.set(m.uid, m);
    }
    return { detail, members: memberByUid };
}

/** 单条历史消息 → IncomingMessage（群场景注入实体，fail-soft）。 */
function translateHistoryMessage(
    api: MilkyApi,
    msg: RawMessage,
    peerUid: string,
    groupData: {
        detail: GroupDetailInfo | undefined;
        members: Map<string, GroupMember>;
    } | null,
): IncomingMessage {
    const ctx: ReceiveTranslateContext = { selfUin: api.self.uin };
    if (groupData !== null) {
        if (groupData.detail !== undefined) {
            ctx.groupEntity = toGroupEntity(groupData.detail, peerUid);
        }
        const member = groupData.members.get(msg.senderUid);
        if (member !== undefined) {
            ctx.groupMemberEntity = toGroupMemberEntity(member, peerUid, msg.senderUin);
        }
    }
    return toMessageReceiveEvent(msg, ctx).data;
}

/** at 段 uid → uin 批量转换（mention 翻译；失败退空 Map）。 */
async function collectUidToUin(api: MilkyApi, msgs: RawMessage[]): Promise<Map<string, string>> {
    const uids = new Set<string>();
    for (const m of msgs) {
        for (const el of toCanonicalElements(m)) {
            if (el.type === "at" && el.target !== "all") {
                uids.add((el as { target: string }).target);
            }
        }
    }
    if (uids.size === 0) {
        return new Map();
    }
    return await api.uidToUin([...uids]).catch((err) => {
        api.logger?.warn(
            { count: uids.size, error: err instanceof Error ? err.message : String(err) },
            "milky: 历史 at uid→uin 失败，mention 段跳过",
        );
        return new Map<string, string>();
    });
}

/** 发送者名（群场景成员缓存昵称/名片，失败退 uin 字符串）。 */
async function senderNameOf(api: MilkyApi, msg: RawMessage): Promise<string> {
    if (api.groupCache !== undefined && msg.chatType === ChatType.GROUP) {
        const member = await api.groupCache.getMember(msg.peerUid, msg.senderUid).catch((err) => {
            api.logger?.debug(
                {
                    group: msg.peerUid,
                    member: msg.senderUid,
                    error: err instanceof Error ? err.message : String(err),
                },
                "milky: 发送者成员缓存读取失败，退 uin 字符串",
            );
            return undefined;
        });
        const name =
            member?.cardName !== undefined && member.cardName !== ""
                ? member.cardName
                : member?.nick;
        if (name !== undefined && name !== "") {
            return name;
        }
    }
    return msg.senderUin;
}

/** 单条消息 → 接收段（canonical 映射 + forward 段注入，forward 不经 canonical）。 */
function receiveSegmentsOf(msg: RawMessage, uidToUin: Map<string, string>): IncomingSegment[] {
    const segments = canonicalToIncomingSegments(toCanonicalElements(msg), {
        ...(uidToUin.size > 0 ? { uidToUin } : {}),
    });
    const fwd = msg.elements.find(
        (el) => el.multiForwardMsgElement != null,
    )?.multiForwardMsgElement;
    if (fwd !== undefined) {
        segments.push(incomingForwardSegment(fwd.resId, fwd.fileName));
    }
    return segments;
}

/** QQ 头像 URL（公开头像服务，640px）。 */
function avatarUrlOf(uin: string): string {
    return uin === "" ? "" : `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`;
}
