/**
 * KernelRuntime：内核服务聚合（开箱即用装配 + 生命周期管理）
 *
 * 把「事件通道 → 原生桥 → 业务 API → 缓存」这套固定装配从 loader 下沉到
 * kernel，外部嵌入方只需一个 `createKernelRuntime({ session })` 即可拿到
 * 全部内核服务，无需理解桥/通道的注册顺序与依赖注入细节。
 *
 * 约定：
 *  - `autoRegister` 默认 true（自动 register 全部桥与缓存）；
 *  - `dispose()` 幂等：一键 unregister 桥/缓存并 dispose 通道；
 *  - `reportOnlineStatus` 默认 false（自建宿主建议 true：status=10 开启服务端
 *    实时消息推送，与 loader 引导链同款调用）。
 */

import { FlashTransferApi } from "./apis/flash-transfer.js";
import { FriendApi } from "./apis/friend.js";
import { GroupApi } from "./apis/group.js";
import { GroupNotifyApi } from "./apis/group-notify.js";
import { MsgApi } from "./apis/msg.js";
import { ProfileApi } from "./apis/profile.js";
import { ProfileLikeApi } from "./apis/profile-like.js";
import { RecentContactApi } from "./apis/recent-contact.js";
import { RichMediaApi } from "./apis/richmedia.js";
import { TicketApi } from "./apis/ticket.js";
import { WebApi } from "./apis/webapi.js";
import type { BuddyEventChannel } from "./bridge/friend-bridge.js";
import { FriendBridge } from "./bridge/friend-bridge.js";
import type { GroupEventChannel } from "./bridge/group-bridge.js";
import { GroupBridge } from "./bridge/group-bridge.js";
import type { LoginEventChannel } from "./bridge/login-bridge.js";
import { LoginBridge } from "./bridge/login-bridge.js";
import type { MsgEventChannel } from "./bridge/msg-bridge.js";
import { MsgBridge } from "./bridge/msg-bridge.js";
import type { RecentContactEventChannel } from "./bridge/recent-contact-bridge.js";
import { RecentContactBridge } from "./bridge/recent-contact-bridge.js";
import { BuddyCache } from "./cache/buddy-cache.js";
import { GroupCache } from "./cache/group-cache.js";
import { NTEventChannel } from "./event-channel.js";
import { errorMessage } from "./infra/index.js";
import type { LoginResult } from "./login/index.js";
import type {
    BuddyListener,
    GroupListener,
    LoginListener,
    MsgListener,
    NodeIQQNTWrapperSession,
    RecentContactListener,
    WrapperNodeApi,
} from "./types/index.js";
import { getOwnProp } from "./utils/type-guards.js";

/** 运行时装配参数。 */
export interface KernelRuntimeOptions {
    /** 已 init 的 wrapper session（getMsgService 等非空）。 */
    session: NodeIQQNTWrapperSession;
    /** 登录结果（WebApi getCookies 的 uin 来源；未传时用空串）。 */
    login?: LoginResult | null | undefined;
    /** wrapper.node exports（MsgApi 富媒体 copyFile 用 NodeQQNTWrapperUtil）。 */
    wrapperExports?: WrapperNodeApi | Record<string, unknown> | undefined;
    /** QQ loginService（传入时装配 LoginBridge，提供 Login 事件通道数据）。 */
    loginService?: unknown;
    /** 校准日志出口（在线状态上报失败等；缺省静默）。 */
    logger?: { warn(obj: unknown, msg?: string): void } | undefined;
    /** 是否自动注册全部原生事件桥与缓存（默认 true）。 */
    autoRegister?: boolean | undefined;
    /** 是否自动上报在线状态 status=10 以开启服务端实时消息推送（默认 false；自建宿主传 true）。 */
    reportOnlineStatus?: boolean | undefined;
}

/** 内核服务聚合（createKernelRuntime 产物）。 */
export interface KernelRuntime {
    readonly msgChannel: MsgEventChannel;
    readonly groupChannel: GroupEventChannel;
    readonly friendChannel: BuddyEventChannel;
    readonly recentContactChannel: RecentContactEventChannel;
    readonly loginChannel: LoginEventChannel;

    readonly msgBridge: MsgBridge;
    readonly groupBridge: GroupBridge;
    readonly friendBridge: FriendBridge;
    /** getRecentContactService 不存在/不可用时为 null（跳过注册）。 */
    readonly recentContactBridge: RecentContactBridge | null;
    /** 未传 loginService 时为 null（跳过注册）。 */
    readonly loginBridge: LoginBridge | null;

    readonly msgApi: MsgApi;
    readonly groupApi: GroupApi;
    readonly friendApi: FriendApi;
    readonly groupNotifyApi: GroupNotifyApi;
    readonly ticketApi: TicketApi;
    readonly richMediaApi: RichMediaApi;
    readonly flashTransferApi: FlashTransferApi;
    readonly recentContactApi: RecentContactApi;
    readonly profileApi: ProfileApi;
    readonly profileLikeApi: ProfileLikeApi;
    readonly webApi: WebApi;

    readonly groupCache: GroupCache;
    readonly buddyCache: BuddyCache;

    /** 一键清理（幂等）：桥/缓存 unregister + 通道 dispose。 */
    dispose(): void;
    /** `using runtime = ...` 自动清理。 */
    [Symbol.dispose](): void;
}

/** 在线状态契约值（与 loader 引导链一致：status=10 = 在线）。 */
const ONLINE_STATUS = 10;

/**
 * 装配内核运行时（同步；API 构造失败即抛 KernelError）。
 *
 * @param opts 装配参数（session 必填）
 * @returns 聚合了全部通道/桥/API/缓存的服务对象
 */
export function createKernelRuntime(opts: KernelRuntimeOptions): KernelRuntime {
    const { session } = opts;
    const msgChannel = new NTEventChannel<MsgListener, "Msg">("Msg");
    const groupChannel = new NTEventChannel<GroupListener, "Group">("Group");
    const friendChannel = new NTEventChannel<BuddyListener, "Buddy">("Buddy");
    const recentContactChannel = new NTEventChannel<RecentContactListener, "RecentContact">(
        "RecentContact",
    );
    const loginChannel = new NTEventChannel<LoginListener, "Login">("Login");

    const msgBridge = new MsgBridge(session, msgChannel);
    const groupBridge = new GroupBridge(session, groupChannel);
    const friendBridge = new FriendBridge(session, friendChannel);
    const recentContactBridge = createRecentContactBridge(session, recentContactChannel);
    const loginBridge = createLoginBridge(opts, loginChannel);

    const groupApi = new GroupApi(session);
    const msgApi = new MsgApi(session, msgChannel, wrapperUtilOf(opts.wrapperExports));
    const friendApi = new FriendApi(session, {
        uidToUin: (uids) => groupApi.uidToUin(uids),
    });
    const groupNotifyApi = new GroupNotifyApi(session);
    const ticketApi = new TicketApi(session);
    const richMediaApi = new RichMediaApi(session);
    const flashTransferApi = new FlashTransferApi(session);
    const recentContactApi = new RecentContactApi(session);
    const profileApi = new ProfileApi(session);
    const profileLikeApi = new ProfileLikeApi(session);
    const webApi = new WebApi({
        getCookies: (domain) => ticketApi.getCookies(domain, opts.login?.uin ?? ""),
    });

    const groupCache = new GroupCache({ channel: groupChannel, groupApi });
    const buddyCache = new BuddyCache({
        channel: friendChannel,
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });

    if (opts.autoRegister !== false) {
        msgBridge.register();
        groupBridge.register();
        friendBridge.register();
        recentContactBridge?.register();
        loginBridge?.register();
        groupCache.register();
        buddyCache.register();
    }
    if (opts.reportOnlineStatus === true) {
        reportOnlineStatus(msgApi, opts.logger);
    }

    let disposed = false;
    const dispose = (): void => {
        if (disposed) {
            return;
        }
        disposed = true;
        msgBridge.unregister();
        groupBridge.unregister();
        friendBridge.unregister();
        recentContactBridge?.unregister();
        loginBridge?.unregister();
        groupCache.unregister();
        buddyCache.unregister();
        msgChannel.dispose();
        groupChannel.dispose();
        friendChannel.dispose();
        recentContactChannel.dispose();
        loginChannel.dispose();
    };

    return {
        msgChannel,
        groupChannel,
        friendChannel,
        recentContactChannel,
        loginChannel,
        msgBridge,
        groupBridge,
        friendBridge,
        recentContactBridge,
        loginBridge,
        msgApi,
        groupApi,
        friendApi,
        groupNotifyApi,
        ticketApi,
        richMediaApi,
        flashTransferApi,
        recentContactApi,
        profileApi,
        profileLikeApi,
        webApi,
        groupCache,
        buddyCache,
        dispose,
        [Symbol.dispose]: dispose,
    };
}

/** wrapper exports → util（支持直接传 exports 或 NodeQQNTWrapperUtil 本身）。 */
function wrapperUtilOf(
    wrapperExports: WrapperNodeApi | Record<string, unknown> | undefined,
): unknown {
    if (wrapperExports === undefined) {
        return undefined;
    }
    const fromExports = getOwnProp(wrapperExports, "NodeQQNTWrapperUtil");
    return fromExports ?? wrapperExports;
}

/** RecentContact 桥：老版本 wrapper 无 getRecentContactService 时跳过。 */
function createRecentContactBridge(
    session: NodeIQQNTWrapperSession,
    channel: RecentContactEventChannel,
): RecentContactBridge | null {
    if (typeof session.getRecentContactService !== "function") {
        return null;
    }
    try {
        return new RecentContactBridge(session, channel);
    } catch {
        return null;
    }
}

/** Login 桥：仅当传入合法 loginService 时装配。 */
function createLoginBridge(
    opts: KernelRuntimeOptions,
    channel: LoginEventChannel,
): LoginBridge | null {
    const loginService = opts.loginService;
    if (loginService === undefined || loginService === null) {
        return null;
    }
    try {
        return new LoginBridge(loginService, channel);
    } catch {
        return null;
    }
}

/** 上报在线状态（失败仅告警：不影响收发链路其余部分）。 */
function reportOnlineStatus(
    msgApi: MsgApi,
    logger: { warn(obj: unknown, msg?: string): void } | undefined,
): void {
    void msgApi
        .setOnlineStatus({
            status: ONLINE_STATUS,
            extStatus: 0,
            batteryStatus: 0,
            customStatus: { faceId: "", wording: "", faceType: "1" },
        })
        .catch((err: unknown) => {
            logger?.warn(
                { error: errorMessage(err) },
                "KernelRuntime: 在线状态上报失败（实时消息推送可能不可用）",
            );
        });
}
