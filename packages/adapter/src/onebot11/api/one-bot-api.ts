/**
 * OneBotApi：OneBot 11 动作的统一依赖聚合（P2-16，基础设施第一项）
 *
 * 单类持有 9 个 kernel apis + 协议层共享状态（messageUnique / self / system 回调），
 * 动作只依赖一个聚合对象（或 Pick 视图），boot.cjs 装配面只出现一个聚合对象。
 *
 * - 便捷方法 uinToUid / uidToUin 委托 groupApi（动作无需再注入转换函数）。
 * - 系统回调拍平为顶层字段（exactOptionalPropertyTypes：显式 `| undefined` 联合）。
 */

import type {
    FriendApi,
    GroupCache,
    GroupNotifyApi,
    MsgApi,
    ProfileApi,
    ProfileLikeApi,
    RichMediaApi,
    TicketApi,
    WebApi,
} from "@napuketto/kernel";
import { GroupApi } from "@napuketto/kernel";
import type { GroupSenderRole } from "../helper/data.js";
import { MessageUnique } from "../helper/message-unique.js";

/** 系统类本地回调（get_version_info / clean_cache / download_file / 进程控制用）。 */
export interface OneBotSystemOptions {
    /** 运行版本（get_version_info 用，缺省 unknown）。 */
    appVersion: string;
    /** 缓存清理回调（clean_cache 用，未配置抛错）。 */
    cleanCache?: () => Promise<void>;
    /** 缓存目录（download_file 保存路径 / get_image 主动下载落盘）。 */
    cacheDir?: string;
    /** QQ NT global 目录（get_image/get_record 解析 NT 相对路径用，2026-09-08 T5）。 */
    mediaBaseDir?: string;
    /** 进程退出回调（bot_exit 用）。 */
    exit?: () => Promise<void>;
    /** 进程重启回调（set_restart 用，缺省退化为退出）。 */
    restart?: () => Promise<void>;
}

/** OneBotApi 构造参数。 */
export interface OneBotApiOptions {
    msgApi: MsgApi;
    groupApi: GroupApi;
    groupNotifyApi: GroupNotifyApi;
    friendApi: FriendApi;
    ticketApi: TicketApi;
    richMediaApi: RichMediaApi;
    profileApi: ProfileApi;
    profileLikeApi: ProfileLikeApi;
    webApi: WebApi;
    /** 登录身份（get_login_info 用）。 */
    self: { uin: string; nickname: string };
    /** 系统类本地信息。 */
    system: OneBotSystemOptions;
    /** 群/成员缓存（ADR-008，读缓存动作用；未装配时动作直查 api）。 */
    groupCache?: GroupCache;
}

/**
 * OneBot 11 动作统一依赖聚合（P2-16）。
 * 各动作经 `Pick<OneBotApi, ...>` 取所需成员；注册处只构造一次本对象。
 */
export class OneBotApi {
    /** kernel 消息 API（send_msg 等消息类动作用）。 */
    readonly msgApi: MsgApi;
    /** kernel 群 API。 */
    readonly groupApi: GroupApi;
    /** kernel 群通知 API（群请求/禁言列表用）。 */
    readonly groupNotifyApi: GroupNotifyApi;
    /** kernel 好友 API。 */
    readonly friendApi: FriendApi;
    /** kernel 票据 API（get_clientkey/get_cookies 用）。 */
    readonly ticketApi: TicketApi;
    /** kernel 富媒体 API（群文件/翻译用）。 */
    readonly richMediaApi: RichMediaApi;
    /** kernel 资料 API（签名/昵称/头像用）。 */
    readonly profileApi: ProfileApi;
    /** kernel 点赞 API（send_like 用）。 */
    readonly profileLikeApi: ProfileLikeApi;
    /** kernel 群空间 web API（精华/荣誉用）。 */
    readonly webApi: WebApi;
    /** 群/成员缓存（ADR-008；翻译层只读消费，缺失惰性回填）。 */
    readonly groupCache: GroupCache | undefined;
    /** OB11 message_id ↔ NT msgId 双向映射（收链路与动作共用同一映射空间）。 */
    readonly messageUnique: MessageUnique;
    /** 登录身份（get_login_info 用）。 */
    readonly self: { uin: string; nickname: string };
    /** 机器人自身 uin（get_cookies / csrf 用）。 */
    readonly selfUin: string;
    /** 运行版本（get_version_info 用）。 */
    readonly appVersion: string;
    /** 缓存清理回调（clean_cache 用）。 */
    readonly cleanCache: (() => Promise<void>) | undefined;
    /** 缓存目录（download_file 用）。 */
    readonly cacheDir: string | undefined;
    /** QQ NT global 目录（媒体 NT 相对路径解析用）。 */
    readonly mediaBaseDir: string | undefined;
    /** 进程退出回调（bot_exit 用）。 */
    readonly exit: (() => Promise<void>) | undefined;
    /** 进程重启回调（set_restart 用）。 */
    readonly restart: (() => Promise<void>) | undefined;

    constructor(opts: OneBotApiOptions) {
        this.msgApi = opts.msgApi;
        this.groupApi = opts.groupApi;
        this.groupNotifyApi = opts.groupNotifyApi;
        this.friendApi = opts.friendApi;
        this.ticketApi = opts.ticketApi;
        this.richMediaApi = opts.richMediaApi;
        this.profileApi = opts.profileApi;
        this.profileLikeApi = opts.profileLikeApi;
        this.webApi = opts.webApi;
        this.groupCache = opts.groupCache;
        this.messageUnique = new MessageUnique();
        this.self = opts.self;
        this.selfUin = opts.self.uin;
        this.appVersion = opts.system.appVersion;
        this.cleanCache = opts.system.cleanCache;
        this.cacheDir = opts.system.cacheDir;
        this.mediaBaseDir = opts.system.mediaBaseDir;
        this.exit = opts.system.exit;
        this.restart = opts.system.restart;
    }

    /** uin→uid 转换（委托 groupApi；私聊目标/成员 user_id 用）。 */
    uinToUid(uins: string[]): Promise<Map<string, string>> {
        return this.groupApi.uinToUid(uins);
    }

    /** uid→uin 转换（委托 groupApi；notice/grayTip 用）。 */
    uidToUin(uids: string[]): Promise<Map<string, string>> {
        return this.groupApi.uidToUin(uids);
    }

    /**
     * 群成员角色（GroupCache 缓存优先，缺失惰性回填；sender.role 判定用）。
     * 未装配缓存 / 成员不在群 / 查询失败 → undefined（调用方回退缺省 "member"，
     * 不阻塞消息上报）。
     */
    async groupMemberRole(groupCode: string, uid: string): Promise<GroupSenderRole | undefined> {
        if (this.groupCache === undefined) {
            return undefined;
        }
        try {
            const member = await this.groupCache.getMember(groupCode, uid);
            return member === undefined ? undefined : GroupApi.roleToString(member.role);
        } catch {
            return undefined;
        }
    }

    /**
     * 群成员角色表（历史消息批量用：一次整表读取，uid → role）。
     * 失败语义同 groupMemberRole。
     */
    async groupMemberRoles(groupCode: string): Promise<Map<string, GroupSenderRole> | undefined> {
        if (this.groupCache === undefined) {
            return undefined;
        }
        try {
            const out = new Map<string, GroupSenderRole>();
            for (const member of await this.groupCache.getMembers(groupCode)) {
                out.set(member.uid, GroupApi.roleToString(member.role));
            }
            return out;
        } catch {
            return undefined;
        }
    }
}
