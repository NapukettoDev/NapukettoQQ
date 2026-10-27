/**
 * MilkyApi：Milky 动作统一依赖聚合（对齐 OneBotApi 模式，P2-16）
 *
 * 持有 P0 动作面所需 kernel apis + 协议层共享状态（seq 双向映射 / 版本 /
 * 发送媒体缓存目录）；动作经 Pick 视图取依赖，装配方只构造一次本对象。
 */
import type {
    FriendApi,
    GroupApi,
    GroupCache,
    MsgApi,
    Peer,
    ProfileApi,
    RawMessage,
} from "@napuketto/kernel";
import { ChatType, kernelError } from "@napuketto/kernel";
import type { MessageSeqIndex } from "./helper/seq-index.js";

/** MilkyApi 构造参数。 */
export interface MilkyApiOptions {
    msgApi: MsgApi;
    groupApi: GroupApi;
    friendApi: FriendApi;
    profileApi: ProfileApi;
    /** 登录身份（get_login_info / self_id 用）。 */
    self: { uin: string; nickname: string };
    /** 群/成员缓存（群实体回填 / get_group_list；未装配时动作直查 api）。 */
    groupCache?: GroupCache;
    /** QQ 客户端版本（get_impl_info.qq_protocol_version）。 */
    qqVersion: string;
    /** 协议端版本（get_impl_info.impl_version）。 */
    implVersion: string;
    /** 发送媒体 http(s)/base64 URI 下载缓存目录（缺省 = 远程媒体发送不可用）。 */
    mediaDir?: string;
}

export class MilkyApi {
    readonly msgApi: MsgApi;
    readonly groupApi: GroupApi;
    readonly friendApi: FriendApi;
    readonly profileApi: ProfileApi;
    readonly self: { uin: string; nickname: string };
    readonly groupCache: GroupCache | undefined;
    readonly qqVersion: string;
    readonly implVersion: string;
    readonly mediaDir: string | undefined;
    /** message_seq ↔ msgId 双向映射（接收链路 record，动作侧反查）。 */
    readonly seqIndex: MessageSeqIndex;

    constructor(opts: MilkyApiOptions, seqIndex: MessageSeqIndex) {
        this.msgApi = opts.msgApi;
        this.groupApi = opts.groupApi;
        this.friendApi = opts.friendApi;
        this.profileApi = opts.profileApi;
        this.self = opts.self;
        this.groupCache = opts.groupCache;
        this.qqVersion = opts.qqVersion;
        this.implVersion = opts.implVersion;
        this.mediaDir = opts.mediaDir;
        this.seqIndex = seqIndex;
    }

    /** uin → uid（私聊目标 / at 段发送转换）。 */
    uinToUid(uins: string[]): Promise<Map<string, string>> {
        return this.groupApi.uinToUid(uins);
    }

    /** uid → uin（事件路径 mention 转换）。 */
    uidToUin(uids: string[]): Promise<Map<string, string>> {
        return this.groupApi.uidToUin(uids);
    }

    /**
     * message_scene + 数字 ID → NT Peer。
     * group = 群号直作 peerUid；friend/temp = uin → uid（失败退 uin 原样，交 QQ 端判断）。
     */
    async resolvePeer(scene: "friend" | "group" | "temp", id: number): Promise<Peer> {
        if (scene === "group") {
            return { chatType: ChatType.GROUP, peerUid: String(id) } satisfies Peer;
        }
        const uin = String(id);
        let uid: string | undefined;
        try {
            uid = (await this.uinToUid([uin])).get(uin);
        } catch {
            // 转换失败：退 uin 原样
        }
        return {
            chatType: scene === "friend" ? ChatType.C2C : ChatType.C2C_TEMP,
            peerUid: uid ?? uin,
        } satisfies Peer;
    }

    /**
     * seq → msgId（索引优先，未登记扫描近段历史兜底）。
     * 两层都未命中返回 undefined（调用方抛 NOT_FOUND）。
     */
    async resolveMsgIdBySeq(
        peer: Peer,
        seq: number,
        chatType: Peer["chatType"],
    ): Promise<string | undefined> {
        const indexed = this.seqIndex.resolveMsgId(chatType, peer.peerUid, seq);
        if (indexed !== undefined) {
            return indexed;
        }
        const msgs = await this.msgApi.fetchMessages(peer, { count: 60 }).catch(() => []);
        const hit = msgs.find((m: RawMessage) => Number(m.msgSeq) === seq);
        if (hit === undefined) {
            return undefined;
        }
        this.seqIndex.record(hit);
        return hit.msgId;
    }

    /** 发送结果回查：msgId → {message_seq, time}（sendMessage 只回 msgId）。 */
    async resolveSentOutput(
        peer: Peer,
        msgId: string,
    ): Promise<{ message_seq: number; time: number }> {
        const [sent] = await this.msgApi.fetchMsgsByMsgId(peer, [msgId]);
        if (sent === undefined) {
            throw kernelError("发送结果回查失败（msgId 未命中）", "UNKNOWN");
        }
        this.seqIndex.record(sent);
        return {
            message_seq: Number(sent.msgSeq),
            time: Math.floor(Number(sent.msgTime) / 1000),
        };
    }
}
