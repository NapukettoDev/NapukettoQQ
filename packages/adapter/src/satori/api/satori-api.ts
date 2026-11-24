/**
 * SatoriApi：Satori 动作的统一依赖聚合（对齐 OB11 的 OneBotApi， 模式）
 *
 * 单类持有 kernel apis + 协议层共享状态（self / cacheDir / 元素转换依赖），
 * 动作只依赖一个聚合对象（或 Pick 视图），装配面只出现一个聚合对象。
 *
 * - 便捷方法 uinToUid / uidToUin 委托 groupApi（at 转换 / 私聊发送用）。
 * - cacheDir 供消息元素发方向资源下载（img/audio/video/file 的 http(s) src）。
 */
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
    FriendApi,
    GroupApi,
    GroupCache,
    GroupNotifyApi,
    MsgApi,
    ProfileApi,
} from "@napuketto/kernel";
import { ChatType, errorMessage, type Peer } from "@napuketto/kernel";
import type { MediaOutboundPolicy } from "@napuketto/media";
import { bindLocalMediaRoots, exportQqMedia } from "../../internal/infra/local-media.js";
import type { AdapterLoggerLike } from "../../internal/infra/log.js";
import { MediaCache } from "../../internal/infra/media-cache.js";
import type { SatoriToCanonicalDeps } from "../helper/element/media-convert.js";

/** SatoriApi 构造参数。 */
export interface SatoriApiOptions {
    /** 相对 media.localMediaRoots 的可信基准目录，缺省为工作目录。 */
    localMediaBaseDir?: string | undefined;
    msgApi: MsgApi;
    groupApi: GroupApi;
    groupNotifyApi: GroupNotifyApi;
    friendApi: FriendApi;
    profileApi: ProfileApi;
    /** 登录身份（login.get / READY logins 用）。 */
    self: { uin: string; nickname: string };
    /** 媒体资源下载缓存目录（缺省 `os.tmpdir()/napuketto-satori-cache`）。 */
    cacheDir?: string | undefined;
    mediaBaseDir?: string | undefined;
    /** 群/成员缓存（guild.member.get / user.get 读缓存用）。 */
    groupCache?: GroupCache | undefined;
    /** 媒体缓存清理失败的可观测出口。 */
    logger?: AdapterLoggerLike | undefined;
}

/** Satori 动作统一依赖聚合。 */
export class SatoriApi {
    readonly mediaCache: MediaCache;
    readonly getLocalMediaRoots?: (() => readonly string[]) | undefined;
    readonly msgApi: MsgApi;
    readonly groupApi: GroupApi;
    readonly groupNotifyApi: GroupNotifyApi;
    readonly friendApi: FriendApi;
    readonly profileApi: ProfileApi;
    readonly self: { uin: string; nickname: string };
    readonly selfUin: string;
    readonly cacheDir: string;
    readonly publishLocalAsset?: ((path: string) => Promise<string | undefined>) | undefined;
    readonly groupCache: GroupCache | undefined;
    /** 动作层可观测出口（媒体缓存/图片元数据探测降级留痕；缺省静默）。 */
    readonly logger: AdapterLoggerLike | undefined;

    /**
     * 频道类型缓存：channel_id → isGroup（群聊频道 id 与私聊 uin 无法从数字
     * 规则区分，需从事件/查询回填——QQ 平台群号与用户 uin 同为数字）。
     */
    private readonly channelTypeCache = new Map<string, boolean>();

    private readonly getMediaOutboundPolicy: (() => MediaOutboundPolicy | undefined) | undefined;

    constructor(
        opts: SatoriApiOptions,
        getMediaOutboundPolicy?: () => MediaOutboundPolicy | undefined,
        getLocalMediaRoots?: () => readonly string[] | undefined,
    ) {
        this.getMediaOutboundPolicy = getMediaOutboundPolicy;
        this.getLocalMediaRoots = bindLocalMediaRoots(opts.localMediaBaseDir, getLocalMediaRoots);
        this.msgApi = opts.msgApi;
        this.groupApi = opts.groupApi;
        this.groupNotifyApi = opts.groupNotifyApi;
        this.friendApi = opts.friendApi;
        this.profileApi = opts.profileApi;
        this.self = opts.self;
        this.selfUin = opts.self.uin;
        this.cacheDir = opts.cacheDir ?? join(tmpdir(), "napuketto-satori-cache");
        this.logger = opts.logger;
        this.mediaCache = new MediaCache({
            root: this.cacheDir,
            logger: opts.logger,
            owner: { protocol: "satori", account: opts.self.uin },
        });
        const mediaBaseDir = opts.mediaBaseDir;
        if (mediaBaseDir !== undefined) {
            this.publishLocalAsset = async (source) => {
                try {
                    const file = await exportQqMedia(source, mediaBaseDir, this.cacheDir);
                    if (file === undefined) return undefined;
                    return `internal:qq/${this.selfUin}/_tmp/${basename(dirname(file))}/${basename(file)}`;
                } catch (err) {
                    opts.logger?.warn({ error: errorMessage(err) }, "satori: 媒体导出失败");
                    return undefined;
                }
            };
        }
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
            outboundPolicy: this.getMediaOutboundPolicy?.(),
            localMediaRoots: this.getLocalMediaRoots?.(),
            account: this.selfUin,
        };
    }
}
