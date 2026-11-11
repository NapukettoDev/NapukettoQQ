/**
 * OneBot 11 动作注册表（ADR-013 延伸）
 * 各协议维护自己的 ActionRegistry，由协议 adapter 挂到请求分发。
 * P2-16：deps 收敛为 { api: OneBotApi } 单聚合对象（基础设施第一项）。
 *
 * 同时是 action 域 barrel：re-export 全部动作类 + error-map + resolve-uid，
 * 协议外部只从本入口消费动作面。
 */
import { ActionRegistry } from "../../core/index.js";
import type { OneBotApi } from "../api/index.js";

export { ob11ErrorCodeMap } from "./error-map.js";
export type { AtAllRemainInfo } from "./group/get-group-at-all-remain.js";
export { resolveUid } from "./resolve-uid.js";

import { DeleteFriendAction } from "./friend/delete-friend.js";
import { GetDoubtFriendsAddRequestAction } from "./friend/get-doubt-friends-add-request.js";
import { GetFriendListAction } from "./friend/get-friend-list.js";
import { GetFriendsWithCategoryAction } from "./friend/get-friends-with-category.js";
import { GetStrangerInfoAction } from "./friend/get-stranger-info.js";
import { SendLikeAction } from "./friend/send-like.js";
import { SetDoubtFriendsAddRequestAction } from "./friend/set-doubt-friends-add-request.js";
import { SetFriendAddRequestAction } from "./friend/set-friend-add-request.js";
import { SetFriendRemarkAction } from "./friend/set-friend-remark.js";
import { DeleteEssenceMsgAction } from "./group/delete-essence-msg.js";
import { GetEssenceMsgListAction } from "./group/get-essence-msg-list.js";
import {
    GetGroupAddRequestAction,
    GetGroupIgnoredNotifiesAction,
} from "./group/get-group-add-request.js";
import { GetGroupAtAllRemainAction } from "./group/get-group-at-all-remain.js";
import { GetGroupHonorInfoAction } from "./group/get-group-honor-info.js";
import { GetGroupInfoAction } from "./group/get-group-info.js";
import { GetGroupListAction } from "./group/get-group-list.js";
import { GetGroupMemberInfoAction } from "./group/get-group-member-info.js";
import { GetGroupMemberListAction } from "./group/get-group-member-list.js";
import { GetGroupShutListAction } from "./group/get-group-shut-list.js";
import { GetGroupSystemMsgAction } from "./group/get-group-system-msg.js";
import {
    CreateGroupFileFolderAction,
    DeleteGroupFileAction,
    DeleteGroupFolderAction,
    MoveGroupFileAction,
    RenameGroupFileAction,
    TransGroupFileAction,
} from "./group/group-files-op.js";
import {
    GetGroupFileSystemInfoAction,
    GetGroupFilesByFolderAction,
    GetGroupRootFilesAction,
} from "./group/group-files-query.js";
import { SetEssenceMsgAction } from "./group/set-essence-msg.js";
import { SetGroupAddRequestAction } from "./group/set-group-add-request.js";
import { SetGroupAdminAction } from "./group/set-group-admin.js";
import { SetGroupBanAction } from "./group/set-group-ban.js";
import { SetGroupCardAction } from "./group/set-group-card.js";
import { SetGroupKickAction } from "./group/set-group-kick.js";
import { SetGroupLeaveAction } from "./group/set-group-leave.js";
import { SetGroupNameAction } from "./group/set-group-name.js";
import { SetGroupWholeBanAction } from "./group/set-group-whole-ban.js";
import { DeleteMsgAction } from "./message/delete-msg.js";
import { FetchPttTextAction } from "./message/fetch-ptt-text.js";
import {
    ForwardFriendSingleMsgAction,
    ForwardGroupSingleMsgAction,
} from "./message/forward-single-msg.js";
import { GetForwardMsgAction } from "./message/get-forward-msg.js";
import { GetFriendMsgHistoryAction } from "./message/get-friend-msg-history.js";
import { GetGroupMsgHistoryAction } from "./message/get-group-msg-history.js";
import { GetImageAction, GetRecordAction } from "./message/get-media.js";
import { GetMsgAction } from "./message/get-msg.js";
import { MarkMsgAsReadAction } from "./message/mark-msg-as-read.js";
import {
    MarkGroupMsgAsReadAction,
    MarkPrivateMsgAsReadAction,
} from "./message/mark-msg-as-read-aliases.js";
import {
    SendGroupForwardMsgAction,
    SendPrivateForwardMsgAction,
} from "./message/send-forward-msg.js";
import { SendGroupMsgAction } from "./message/send-group-msg.js";
import { SendMsgAction } from "./message/send-msg.js";
import { SendPrivateMsgAction } from "./message/send-private-msg.js";
import { SetInputStatusAction } from "./message/set-input-status.js";
import { SetMsgEmojiLikeAction } from "./message/set-msg-emoji-like.js";
import { CanSendImageAction } from "./system/can-send-image.js";
import { CanSendRecordAction } from "./system/can-send-record.js";
import { CleanCacheAction } from "./system/clean-cache.js";
import { DownloadFileAction } from "./system/download-file.js";
import { GetClientkeyAction } from "./system/get-clientkey.js";
import { GetCookiesAction } from "./system/get-cookies.js";
import { GetCredentialsAction, GetCsrfTokenAction } from "./system/get-credentials.js";
import { GetLoginInfoAction } from "./system/get-login-info.js";
import { GetRobotUinRangeAction } from "./system/get-robot-uin-range.js";
import { GetStatusAction } from "./system/get-status.js";
import { GetVersionInfoAction } from "./system/get-version-info.js";
import { BotExitAction, SetRestartAction } from "./system/process-control.js";
import {
    SetQQAvatarAction,
    SetQQProfileAction,
    SetSelfLongnickAction,
} from "./system/profile-actions.js";
import { SetDiyOnlineStatusAction } from "./system/set-diy-online-status.js";
import { SetOnlineStatusAction } from "./system/set-online-status.js";
import { TranslateEn2ZhAction } from "./system/translate-en2zh.js";
import { UploadGroupFileAction, UploadPrivateFileAction } from "./upload-file.js";

/** 动作注册表依赖（P2-16：动作只依赖一个聚合对象）。 */
export interface Ob11ActionDeps {
    /** OneBotApi 聚合（9 个 kernel apis + messageUnique + self/system）。 */
    api: OneBotApi;
}

/** 构建 OB11 动作注册表（所有 OB11 动作在此注册，按组拆分控制行数）。 */
export function createOb11ActionRegistry(deps: Ob11ActionDeps): ActionRegistry {
    const registry = new ActionRegistry();
    registerMsgActions(registry, deps);
    registerForwardActions(registry, deps);
    registerQueryActions(registry, deps);
    registerGroupActions(registry, deps);
    registerFriendActions(registry, deps);
    registerSystemActions(registry, deps);
    registerGroupNotifyActions(registry, deps);
    registerTicketActions(registry, deps);
    registerProfileActions(registry, deps);
    registerGroupFileActions(registry, deps);
    registerFileUploadActions(registry, deps);
    registerWebActions(registry, deps);
    return registry;
}

/**
 * 文件投递动作（upload_group_file / upload_private_file）：**闪传通道**。
 * 语义降级说明见 ./upload-file.ts 文件头（分享卡片，非群文件条目）。
 */
function registerFileUploadActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new UploadGroupFileAction(deps.api));
    registry.register(new UploadPrivateFileAction(deps.api));
}

/** 群空间 web / csrf / 陌生人 / 群请求动作（P2-15）。 */
function registerWebActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new GetStrangerInfoAction(deps.api.profileApi));
    registry.register(new GetCsrfTokenAction(deps.api));
    registry.register(new GetCredentialsAction(deps.api));
    registry.register(new GetGroupAddRequestAction(deps.api.groupNotifyApi));
    registry.register(new GetGroupIgnoredNotifiesAction(deps.api.groupNotifyApi));
    registry.register(new GetEssenceMsgListAction(deps.api.webApi));
    registry.register(new GetGroupHonorInfoAction(deps.api.webApi));
}

/** 资料/点赞/翻译动作（P2-14）。 */
function registerProfileActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new SetSelfLongnickAction(deps.api.profileApi));
    registry.register(new SetQQProfileAction(deps.api.profileApi));
    registry.register(new SetQQAvatarAction(deps.api));
    registry.register(new TranslateEn2ZhAction(deps.api.richMediaApi));
    registry.register(new SendLikeAction(deps.api));
}

/** 群文件动作（P2-14）。 */
function registerGroupFileActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new GetGroupRootFilesAction(deps.api.richMediaApi));
    registry.register(new GetGroupFilesByFolderAction(deps.api.richMediaApi));
    registry.register(new GetGroupFileSystemInfoAction(deps.api.richMediaApi));
    registry.register(new CreateGroupFileFolderAction(deps.api.richMediaApi));
    registry.register(new DeleteGroupFileAction(deps.api.richMediaApi));
    registry.register(new DeleteGroupFolderAction(deps.api.richMediaApi));
    registry.register(new RenameGroupFileAction(deps.api.richMediaApi));
    registry.register(new MoveGroupFileAction(deps.api.richMediaApi));
    registry.register(new TransGroupFileAction(deps.api.richMediaApi));
}

/** 群通知/禁言列表动作（P2-13）。 */
function registerGroupNotifyActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new SetGroupAddRequestAction(deps.api.groupNotifyApi));
    registry.register(new GetGroupSystemMsgAction(deps.api));
    registry.register(new GetGroupShutListAction(deps.api));
}

/** 票据动作（P2-13）。 */
function registerTicketActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new GetClientkeyAction(deps.api.ticketApi));
    registry.register(new GetCookiesAction(deps.api));
}

/** 合并转发 / 单条转发 / 在线状态（P2-12）。 */
function registerForwardActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new SendGroupForwardMsgAction(deps.api));
    registry.register(new SendPrivateForwardMsgAction(deps.api));
    registry.register(new GetForwardMsgAction(deps.api));
    registry.register(new ForwardGroupSingleMsgAction(deps.api));
    registry.register(new ForwardFriendSingleMsgAction(deps.api));
    registry.register(new SetOnlineStatusAction(deps.api.msgApi));
    registry.register(new SetDiyOnlineStatusAction(deps.api.msgApi));
}

/** 消息类动作（P2-3 / P2-10 / P2-11）。 */
function registerMsgActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new SendMsgAction(deps.api));
    registry.register(new SendPrivateMsgAction(deps.api));
    registry.register(new SendGroupMsgAction(deps.api));
    registry.register(new DeleteMsgAction(deps.api));
    registry.register(new GetMsgAction(deps.api));
    registry.register(new GetGroupMsgHistoryAction(deps.api));
    registry.register(new GetFriendMsgHistoryAction(deps.api));
    registry.register(new MarkMsgAsReadAction(deps.api));
    registry.register(new MarkPrivateMsgAsReadAction(deps.api));
    registry.register(new MarkGroupMsgAsReadAction(deps.api));
    registry.register(new SetMsgEmojiLikeAction(deps.api));
    registry.register(new FetchPttTextAction(deps.api));
    registry.register(new SetInputStatusAction(deps.api));
    registry.register(new GetImageAction(deps.api));
    registry.register(new GetRecordAction(deps.api));
}

/** 查询类动作（P2-4；P2-17 群信息/成员动作读 GroupCache）。 */
function registerQueryActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new GetLoginInfoAction(deps.api.self));
    registry.register(new GetGroupInfoAction(deps.api));
    registry.register(new GetGroupListAction(deps.api));
    registry.register(new GetGroupMemberInfoAction(deps.api));
    registry.register(new GetGroupMemberListAction(deps.api));
    registry.register(new GetFriendListAction(deps.api.friendApi));
}

/** 群管类动作（P2-10）。 */
function registerGroupActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new SetGroupKickAction(deps.api.groupApi));
    registry.register(new SetGroupBanAction(deps.api.groupApi));
    registry.register(new SetGroupWholeBanAction(deps.api.groupApi));
    registry.register(new SetGroupAdminAction(deps.api.groupApi));
    registry.register(new SetGroupCardAction(deps.api.groupApi));
    registry.register(new SetGroupNameAction(deps.api.groupApi));
    registry.register(new SetGroupLeaveAction(deps.api.groupApi));
    registry.register(new SetEssenceMsgAction(deps.api));
    registry.register(new DeleteEssenceMsgAction(deps.api));
    registry.register(new GetGroupAtAllRemainAction(deps.api.groupApi));
}

/** 好友类动作（P2-11）。 */
function registerFriendActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new SetFriendAddRequestAction(deps.api.friendApi));
    registry.register(new SetFriendRemarkAction(deps.api));
    registry.register(new DeleteFriendAction(deps.api));
    registry.register(new GetFriendsWithCategoryAction(deps.api.friendApi));
    registry.register(new GetDoubtFriendsAddRequestAction(deps.api.friendApi));
    registry.register(new SetDoubtFriendsAddRequestAction(deps.api.friendApi));
}

/** 系统类动作（P2-11 / P2-12）。 */
function registerSystemActions(registry: ActionRegistry, deps: Ob11ActionDeps): void {
    registry.register(new GetStatusAction());
    registry.register(new GetVersionInfoAction(deps.api));
    registry.register(new CleanCacheAction(deps.api));
    registry.register(new CanSendImageAction());
    registry.register(new CanSendRecordAction());
    registry.register(new GetRobotUinRangeAction());
    registry.register(new DownloadFileAction(deps.api));
    registry.register(new BotExitAction(deps.api));
    registry.register(new SetRestartAction(deps.api));
}

/** action 域公共面（barrel re-export，协议外部从本入口消费动作类）。 */
export {
    BotExitAction,
    CanSendImageAction,
    CanSendRecordAction,
    CleanCacheAction,
    CreateGroupFileFolderAction,
    DeleteEssenceMsgAction,
    DeleteFriendAction,
    DeleteGroupFileAction,
    DeleteGroupFolderAction,
    DeleteMsgAction,
    DownloadFileAction,
    FetchPttTextAction,
    ForwardFriendSingleMsgAction,
    ForwardGroupSingleMsgAction,
    GetClientkeyAction,
    GetCookiesAction,
    GetCredentialsAction,
    GetCsrfTokenAction,
    GetDoubtFriendsAddRequestAction,
    GetEssenceMsgListAction,
    GetForwardMsgAction,
    GetFriendListAction,
    GetFriendMsgHistoryAction,
    GetFriendsWithCategoryAction,
    GetGroupAddRequestAction,
    GetGroupAtAllRemainAction,
    GetGroupFileSystemInfoAction,
    GetGroupFilesByFolderAction,
    GetGroupHonorInfoAction,
    GetGroupIgnoredNotifiesAction,
    GetGroupInfoAction,
    GetGroupListAction,
    GetGroupMemberInfoAction,
    GetGroupMemberListAction,
    GetGroupMsgHistoryAction,
    GetGroupRootFilesAction,
    GetGroupShutListAction,
    GetGroupSystemMsgAction,
    GetImageAction,
    GetLoginInfoAction,
    GetRecordAction,
    GetRobotUinRangeAction,
    GetStatusAction,
    GetStrangerInfoAction,
    GetVersionInfoAction,
    MarkGroupMsgAsReadAction,
    MarkMsgAsReadAction,
    MarkPrivateMsgAsReadAction,
    MoveGroupFileAction,
    RenameGroupFileAction,
    SendGroupForwardMsgAction,
    SendGroupMsgAction,
    SendLikeAction,
    SendMsgAction,
    SendPrivateForwardMsgAction,
    SendPrivateMsgAction,
    SetDiyOnlineStatusAction,
    SetDoubtFriendsAddRequestAction,
    SetEssenceMsgAction,
    SetFriendAddRequestAction,
    SetFriendRemarkAction,
    SetGroupAddRequestAction,
    SetGroupAdminAction,
    SetGroupBanAction,
    SetGroupCardAction,
    SetGroupKickAction,
    SetGroupLeaveAction,
    SetGroupNameAction,
    SetGroupWholeBanAction,
    SetInputStatusAction,
    SetMsgEmojiLikeAction,
    SetOnlineStatusAction,
    SetQQAvatarAction,
    SetQQProfileAction,
    SetRestartAction,
    SetSelfLongnickAction,
    TransGroupFileAction,
    TranslateEn2ZhAction,
};
