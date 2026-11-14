/**
 * SatoriApi：Satori 动作的统一依赖聚合（对齐 OB11 的 OneBotApi，P2-16 模式）
 *
 * 单类持有 kernel apis + 协议层共享状态（self / cacheDir / 元素转换依赖），
 * 动作只依赖一个聚合对象（或 Pick 视图），装配面只出现一个聚合对象。
 *
 * - 便捷方法 uinToUid / uidToUin 委托 groupApi（at 转换 / 私聊发送用）。
 * - cacheDir 供消息元素发方向资源下载（img/audio/video/file 的 http(s) src）。
 */
import type {
    FriendApi,
    GroupApi,
    GroupCache,
    GroupNotifyApi,
    MsgApi,
    ProfileApi,
} from "@napuketto/kernel";
import { ChatType, type Peer } from "@napuketto/kernel";
import type { SatoriToCanonicalDeps } from "../helper/element/deps.js";

/** SatoriApi 构造参数。 */
export interface SatoriApiOptions {
    msgApi: MsgApi;
    groupApi: GroupApi;
    groupNotifyApi: GroupNotifyApi;
    friendApi: FriendApi;
    profileApi: ProfileApi;
    /** 登录身份（login.get / READY logins 用）。 */
    self: { uin: string; nickname: string };
    /** 媒体资源下载缓存目录（发方向 img/audio/video/file 的 http(s) src）。 */
    cacheDir: string;
    /** 群/成员缓存（ADR-008；guild.member.get / user.get 读缓存用）。 */
    groupCache?: GroupCache;
}

/** Satori 动作统一依赖聚合。 */
export class SatoriApi {
    readonly msgApi: MsgApi;
    readonly groupApi: GroupApi;
    readonly groupNotifyApi: GroupNotifyApi;
    readonly friendApi: FriendApi;
    readonly profileApi: ProfileApi;
    readonly self: { uin: string; nickname: string };
    readonly selfUin: string;
    readonly cacheDir: string;
    readonly groupCache: GroupCache | undefined;

    /**
     * 频道类型缓存：channel_id → isGroup（群聊频道 id 与私聊 uin 无法从数字
     * 规则区分，需从事件/查询回填——QQ 平台群号与用户 uin 同为数字）。
     */
    private readonly channelTypeCache = new Map<string, boolean>();

    constructor(opts: SatoriApiOptions) {
        this.msgApi = opts.msgApi;
        this.groupApi = opts.groupApi;
        this.groupNotifyApi = opts.groupNotifyApi;
        this.friendApi = opts.friendApi;
        this.profileApi = opts.profileApi;
        this.self = opts.self;
        this.selfUin = opts.self.uin;
        this.cacheDir = opts.cacheDir;
        this.groupCache = opts.groupCache;
    }

    /** 记录频道类型（消息事件翻译时回填：chatType GROUP → true）。 */
    setChannelType(channelId: string, isGroup: boolean): void {
        this.channelTypeCache.set(channelId, isGroup);
    }

    /**
     * 解析 channel_id → Peer（消息动作共用）。
     * 缓存命中直接取类型；未命中先试群号（getGroupInfo 成功 = 群聊），
     * 失败按私聊（uin → uid）。
     */
    async resolvePeer(channelId: string): Promise<Peer> {
        const cached = this.channelTypeCache.get(channelId);
        if (cached === true) {
            return { chatType: ChatType.GROUP, peerUid: channelId };
        }
        if (cached === false) {
            return this.toC2cPeer(channelId);
        }
        const isGroup = await this.groupApi
            .getGroupInfo(channelId)
            .then(() => true)
            .catch(() => false);
        this.channelTypeCache.set(channelId, isGroup);
        if (isGroup) {
            return { chatType: ChatType.GROUP, peerUid: channelId };
        }
        return this.toC2cPeer(channelId);
    }

    /** uin → 私聊 Peer（uin→uid 转换；转换失败原样 uin 兜底）。 */
    private async toC2cPeer(uin: string): Promise<Peer> {
        const map = await this.groupApi.uinToUid([uin]);
        const uid = map.get(uin) ?? uin;
        return { chatType: ChatType.C2C, peerUid: uid };
    }

    /** uin → uid（委托 groupApi；私聊发送 / at 目标用）。 */
    uinToUid(uins: string[]): Promise<Map<string, string>> {
        return this.groupApi.uinToUid(uins);
    }

    /** uid → uin（委托 groupApi；收方向 at / 用户 ID 用）。 */
    uidToUin(uids: string[]): Promise<Map<string, string>> {
        return this.groupApi.uidToUin(uids);
    }

    /** 发方向元素转换依赖（at uin→uid + 资源下载目录）。 */
    toCanonicalDeps(): SatoriToCanonicalDeps {
        return {
            uinToUid: (uins) => this.groupApi.uinToUid(uins),
            cacheDir: this.cacheDir,
        };
    }
}
