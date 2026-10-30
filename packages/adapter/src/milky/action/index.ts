/**
 * Milky 动作注册表（P0：9 个动作）
 *
 * P0 面 = docs/protocols/milky.md §9 P0 清单：get_login_info / get_impl_info /
 * send_private_message / send_group_message / get_message / recall_*_message /
 * get_friend_list / get_group_list。P1 扩面（群管/精华/群文件/好友请求/票据）
 * 往本注册表追加。
 */
import { ActionRegistry } from "../../core/index.js";
import type { MilkyApi } from "../api.js";
import type { MilkyAction } from "./base-action.js";
import {
    GetMessageAction,
    RecallGroupMessageAction,
    RecallPrivateMessageAction,
    SendGroupMessageAction,
    SendPrivateMessageAction,
} from "./message.js";
import { GetFriendListAction, GetGroupListAction } from "./social.js";
import { GetImplInfoAction, GetLoginInfoAction } from "./system.js";

/** Milky 动作注册表（P0 9 动作）。 */
export function createMilkyActionRegistry(opts: {
    api: MilkyApi;
}): ActionRegistry<MilkyAction<unknown, unknown>> {
    const registry = new ActionRegistry<MilkyAction<unknown, unknown>>();
    const { api } = opts;
    registry.register(new GetLoginInfoAction(api));
    registry.register(new GetImplInfoAction(api));
    registry.register(new SendPrivateMessageAction(api));
    registry.register(new SendGroupMessageAction(api));
    registry.register(new GetMessageAction(api));
    registry.register(new RecallPrivateMessageAction(api));
    registry.register(new RecallGroupMessageAction(api));
    registry.register(new GetFriendListAction(api));
    registry.register(new GetGroupListAction(api));
    return registry;
}
