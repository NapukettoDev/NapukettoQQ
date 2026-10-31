/**
 * MilkyApi：Milky 动作统一依赖聚合（对齐 OneBotApi 模式，P2-16）
 *
 * 持有 P1 动作面所需 kernel apis + 协议层共享状态（seq 双向映射 / 转发索引 /
 * 版本 / 发送媒体缓存目录）；动作经 Pick 视图取依赖，装配方只构造一次本对象。
 */
import type {
    BuddyReq,
    FriendApi,
    GroupApi,
    GroupCache,
    GroupNotify,
    GroupNotifyApi,
    MsgApi,
    Peer,
    ProfileApi,
    ProfileLikeApi,
    RawMessage,
    RecentContactApi,
    RichMediaApi,
    TicketApi,
    WebApi,
} from "@napuketto/kernel";
import { ChatType, kernelError } from "@napuketto/kernel";
import type { MessageSeqIndex } from "./helper/seq-index.js";
import type { MilkyLoggerLike } from "./transport.js";

/** MilkyApi 构造参数。 */
export interface MilkyApiOptions {
    msgApi: MsgApi;
    groupApi: GroupApi;
    friendApi: FriendApi;
    profileApi: ProfileApi;
    /** P1 扩面依赖（表态度 / 票据 / 精华列表 / 群通知 / 群文件）。 */
    profileLikeApi: ProfileLikeApi;
    ticketApi: TicketApi;
    webApi: WebApi;
    groupNotifyApi: GroupNotifyApi;
    richMediaApi: RichMediaApi;
    /** P2 批次二：会话列表（get_peer_pins 数据源）。 */
    recentContactApi: RecentContactApi;
    /** 登录身份（get_login_info / self_id / target_user_uid 用）。 */
    self: { uin: string; nickname: string; uid?: string };
    /** 群/成员缓存（群实体回填 / get_group_list；未装配时动作直查 api）。 */
    groupCache?: GroupCache;
    /** QQ 客户端版本（get_impl_info.qq_protocol_version）。 */
    qqVersion: string;
    /** 协议端版本（get_impl_info.impl_version）。 */
    implVersion: string;
    /** 发送媒体 http(s)/base64 URI 下载缓存目录（缺省 = 远程媒体发送不可用）。 */
    mediaDir?: string;
    /** 动作层可观测出口（P2 批次一：forward 临时消息撤回失败 warn；缺省静默）。 */
    logger?: MilkyLoggerLike;
}

export class MilkyApi {
    readonly msgApi: MsgApi;
    readonly groupApi: GroupApi;
    readonly friendApi: FriendApi;
    readonly profileApi: ProfileApi;
    readonly profileLikeApi: ProfileLikeApi;
    readonly ticketApi: TicketApi;
    readonly webApi: WebApi;
    readonly groupNotifyApi: GroupNotifyApi;
    readonly richMediaApi: RichMediaApi;
    readonly recentContactApi: RecentContactApi;
    readonly self: { uin: string; nickname: string; uid?: string };
    readonly groupCache: GroupCache | undefined;
    readonly qqVersion: string;
    readonly implVersion: string;
    readonly mediaDir: string | undefined;
    /** 动作层可观测出口（缺省静默）。 */
    readonly logger: MilkyLoggerLike | undefined;
    /** message_seq ↔ msgId 双向映射（接收链路 record，动作侧反查）。 */
    readonly seqIndex: MessageSeqIndex;

    constructor(opts: MilkyApiOptions, seqIndex: MessageSeqIndex) {
        this.msgApi = opts.msgApi;
        this.groupApi = opts.groupApi;
        this.friendApi = opts.friendApi;
        this.profileApi = opts.profileApi;
        this.profileLikeApi = opts.profileLikeApi;
        this.ticketApi = opts.ticketApi;
        this.webApi = opts.webApi;
        this.groupNotifyApi = opts.groupNotifyApi;
        this.richMediaApi = opts.richMediaApi;
        this.recentContactApi = opts.recentContactApi;
        this.self = opts.self;
        this.groupCache = opts.groupCache;
        this.qqVersion = opts.qqVersion;
        this.implVersion = opts.implVersion;
        this.mediaDir = opts.mediaDir;
        this.logger = opts.logger;
        this.seqIndex = seqIndex;
    }

    /** uin → uid（私聊目标 / at 段发送转换 / 群管动作的 uid 入参）。 */
    uinToUid(uins: string[]): Promise<Map<string, string>> {
        return this.groupApi.uinToUid(uins);
    }

    /** uid → uin（事件路径 mention 转换）。 */
    uidToUin(uids: string[]): Promise<Map<string, string>> {
        return this.groupApi.uidToUin(uids);
    }

    /**
     * uin（数字）→ uid（群管动作入参转换）；转换失败抛 INVALID_PARAM
     * （Milky 入参 user_id 都是 uin，kernel 群管 API 要 uid）。
     */
    async resolveUidFromUin(uin: number | string): Promise<string> {
        const uinStr = String(uin);
        try {
            const uid = (await this.uinToUid([uinStr])).get(uinStr);
            if (uid !== undefined && uid !== "") {
                return uid;
            }
        } catch {
            // 落到下方报错
        }
        throw kernelError(`用户 ${uinStr} 不存在或 uin→uid 转换失败`, "INVALID_PARAM");
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

/** 通知查找默认搜索数量（单屏全量，OB11 DEFAULT_COUNT 同值）。 */
const NOTIFY_SEARCH_COUNT = 100;

/**
 * 按通知 seq 查找群通知（先非可疑后可疑，OB11 set_group_add_request 同路径）。
 * 未找到抛 NOT_FOUND（应答动作的 seq 无效或已过期）。
 * 模块级函数（非类成员）：应答动作的公共入口，OB11 同路径。
 */
export async function findGroupNotify(api: MilkyApi, seq: string): Promise<GroupNotify> {
    const normal = await api.groupNotifyApi.getSingleScreenNotifies(false, NOTIFY_SEARCH_COUNT);
    const hit = normal.find((item) => item.seq === seq);
    if (hit !== undefined) {
        return hit;
    }
    const doubt = await api.groupNotifyApi.getSingleScreenNotifies(true, NOTIFY_SEARCH_COUNT);
    const doubtHit = doubt.find((item) => item.seq === seq);
    if (doubtHit !== undefined) {
        return doubtHit;
    }
    throw kernelError(`未找到通知 ${seq}（无效或已过期）`, "NOT_FOUND");
}

/** 按发起者 uid 查找好友申请（getBuddyReqList 匹配 friendUid）；未找到抛 NOT_FOUND。 */
export async function findBuddyReq(api: MilkyApi, initiatorUid: string): Promise<BuddyReq> {
    const reqs = await api.friendApi.getBuddyReqList();
    const hit = reqs.find((req) => req.friendUid === initiatorUid);
    if (hit === undefined) {
        throw kernelError(`未找到来自 ${initiatorUid} 的好友申请`, "NOT_FOUND");
    }
    return hit;
}
