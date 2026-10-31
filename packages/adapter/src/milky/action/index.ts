/**
 * Milky 动作注册表（P0 9 + P1 40 + P2 批次二 15 = 64 个）
 *
 * P0/P1 面 = docs/protocols/milky.md §9 清单；批次二 = §0.7（nudge / 公告 /
 * 头衔 / 群头像 / peer_pins / 上传 / download_url / rename_folder / 收藏表情 /
 * resource 反查）。
 */
import { ActionRegistry } from "../../core/index.js";
import type { MilkyApi } from "../api.js";
import type { MilkyAction } from "./base-action.js";
import {
    AcceptGroupInvitationAction,
    AcceptGroupRequestAction,
    DeleteGroupAnnouncementAction,
    GetGroupAnnouncementsAction,
    GetGroupEssenceMessagesAction,
    GetGroupInfoAction,
    GetGroupMemberInfoAction,
    GetGroupMemberListAction,
    GetGroupNotificationsAction,
    KickGroupMemberAction,
    QuitGroupAction,
    RejectGroupInvitationAction,
    RejectGroupRequestAction,
    SendGroupAnnouncementAction,
    SendGroupMessageReactionAction,
    SendGroupNudgeAction,
    SetGroupAvatarAction,
    SetGroupEssenceMessageAction,
    SetGroupMemberAdminAction,
    SetGroupMemberCardAction,
    SetGroupMemberMuteAction,
    SetGroupMemberSpecialTitleAction,
    SetGroupNameAction,
    SetGroupWholeMuteAction,
} from "./group.js";
import {
    CreateGroupFolderAction,
    DeleteGroupFileAction,
    DeleteGroupFolderAction,
    GetGroupFileDownloadUrlAction,
    GetGroupFilesAction,
    MoveGroupFileAction,
    PersistGroupFileAction,
    RenameGroupFileAction,
    RenameGroupFolderAction,
    UploadGroupFileAction,
} from "./group-file.js";
import {
    GetCustomFaceUrlListAction,
    GetForwardedMessagesAction,
    GetHistoryMessagesAction,
    GetMessageAction,
    GetResourceTempUrlAction,
    MarkMessageAsReadAction,
    RecallGroupMessageAction,
    RecallPrivateMessageAction,
    SendGroupMessageAction,
    SendPrivateMessageAction,
    UploadPrivateFileAction,
} from "./message.js";
import {
    GetCookiesAction,
    GetCSRFTokenAction,
    GetFriendInfoAction,
    GetUserProfileAction,
    SetAvatarAction,
    SetBioAction,
    SetNicknameAction,
} from "./profile.js";
import {
    AcceptFriendRequestAction,
    DeleteFriendAction,
    GetFriendListAction,
    GetFriendRequestsAction,
    GetGroupListAction,
    GetPeerPinsAction,
    RejectFriendRequestAction,
    SendFriendNudgeAction,
    SendProfileLikeAction,
    SetPeerPinAction,
} from "./social.js";
import { GetImplInfoAction, GetLoginInfoAction } from "./system.js";

/** Milky 动作注册表（P0+P1 49 动作）。 */
export function createMilkyActionRegistry(opts: {
    api: MilkyApi;
}): ActionRegistry<MilkyAction<unknown, unknown>> {
    const registry = new ActionRegistry<MilkyAction<unknown, unknown>>();
    const { api } = opts;
    // P0
    registry.register(new GetLoginInfoAction(api));
    registry.register(new GetImplInfoAction(api));
    registry.register(new SendPrivateMessageAction(api));
    registry.register(new SendGroupMessageAction(api));
    registry.register(new GetMessageAction(api));
    registry.register(new RecallPrivateMessageAction(api));
    registry.register(new RecallGroupMessageAction(api));
    registry.register(new GetFriendListAction(api));
    registry.register(new GetGroupListAction(api));
    // P1 资料/票据
    registry.register(new GetUserProfileAction(api));
    registry.register(new GetFriendInfoAction(api));
    registry.register(new SetAvatarAction(api));
    registry.register(new SetNicknameAction(api));
    registry.register(new SetBioAction(api));
    registry.register(new GetCookiesAction(api));
    registry.register(new GetCSRFTokenAction(api));
    // P1 好友
    registry.register(new SendProfileLikeAction(api));
    registry.register(new DeleteFriendAction(api));
    registry.register(new GetFriendRequestsAction(api));
    registry.register(new AcceptFriendRequestAction(api));
    registry.register(new RejectFriendRequestAction(api));
    // P1 消息
    registry.register(new GetHistoryMessagesAction(api));
    registry.register(new GetForwardedMessagesAction(api));
    registry.register(new MarkMessageAsReadAction(api));
    // P1 群
    registry.register(new GetGroupInfoAction(api));
    registry.register(new GetGroupMemberListAction(api));
    registry.register(new GetGroupMemberInfoAction(api));
    registry.register(new SetGroupNameAction(api));
    registry.register(new SetGroupMemberCardAction(api));
    registry.register(new SetGroupMemberAdminAction(api));
    registry.register(new SetGroupMemberMuteAction(api));
    registry.register(new SetGroupWholeMuteAction(api));
    registry.register(new KickGroupMemberAction(api));
    registry.register(new QuitGroupAction(api));
    registry.register(new GetGroupEssenceMessagesAction(api));
    registry.register(new SetGroupEssenceMessageAction(api));
    registry.register(new SendGroupMessageReactionAction(api));
    registry.register(new GetGroupNotificationsAction(api));
    registry.register(new AcceptGroupRequestAction(api));
    registry.register(new RejectGroupRequestAction(api));
    registry.register(new AcceptGroupInvitationAction(api));
    registry.register(new RejectGroupInvitationAction(api));
    // P1 群文件
    registry.register(new GetGroupFilesAction(api));
    registry.register(new MoveGroupFileAction(api));
    registry.register(new RenameGroupFileAction(api));
    registry.register(new DeleteGroupFileAction(api));
    registry.register(new PersistGroupFileAction(api));
    registry.register(new CreateGroupFolderAction(api));
    registry.register(new DeleteGroupFolderAction(api));
    // P2 批次二（§0.7）
    registry.register(new SendFriendNudgeAction(api));
    registry.register(new GetPeerPinsAction(api));
    registry.register(new SetPeerPinAction(api));
    registry.register(new SendGroupNudgeAction(api));
    registry.register(new GetGroupAnnouncementsAction(api));
    registry.register(new SendGroupAnnouncementAction(api));
    registry.register(new DeleteGroupAnnouncementAction(api));
    registry.register(new SetGroupAvatarAction(api));
    registry.register(new SetGroupMemberSpecialTitleAction(api));
    registry.register(new GetCustomFaceUrlListAction(api));
    registry.register(new GetResourceTempUrlAction(api));
    registry.register(new UploadPrivateFileAction(api));
    registry.register(new UploadGroupFileAction(api));
    registry.register(new GetGroupFileDownloadUrlAction(api));
    registry.register(new RenameGroupFolderAction(api));
    return registry;
}
