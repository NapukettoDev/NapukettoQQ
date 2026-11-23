/**
 * OneBot 11 请求事件（request）：加好友 / 加群
 *
 * 请求事件由第三方框架处理，通过 set_friend_add_request / set_group_add_request
 * 动作应答（flag 透传）。
 */

import type { GroupRequestKind } from "@napuketto/kernel";
import type { OB11BaseEvent } from "./base.js";

/** 加好友请求。 */
export interface OB11FriendRequestEvent extends OB11BaseEvent {
    post_type: "request";
    request_type: "friend";
    user_id: number;
    /** 验证信息。 */
    comment: string;
    /** 请求 flag，应答时原样传回。 */
    flag: string;
}

/** 加群请求 / 邀请。 */
export interface OB11GroupRequestEvent extends OB11BaseEvent {
    post_type: "request";
    request_type: "group";
    /** add 他人申请入群 / invite 群主或管理邀请。 */
    sub_type: "add" | "invite";
    group_id: number;
    user_id: number;
    comment: string;
    flag: string;
    /** 通知队列。审批时随 flag 一并回传。 */
    doubt: boolean;
    /** 区分邀请本账号、邀请他人待审批与入群申请。 */
    request_kind: GroupRequestKind;
}

/** OB11 请求事件联合。 */
export type OB11RequestEvent = OB11FriendRequestEvent | OB11GroupRequestEvent;
