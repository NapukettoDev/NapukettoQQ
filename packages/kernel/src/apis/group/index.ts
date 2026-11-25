/**
 * 群域公共出口（GroupApi + 群通知 + 解析器 / 公告子模块）。
 */

export { GroupApi } from "./group.js";
export {
    deleteGroupAnnouncement,
    getGroupAnnouncements,
    publishGroupAnnouncement,
} from "./group-bulletin.js";
export {
    findPendingGroupRequest,
    GroupNotifyApi,
    type GroupRequestKind,
    type GroupRequestRef,
    type PendingGroupRequest,
    toPendingGroupRequest,
} from "./group-notify.js";
export { extractGroupDetail } from "./group-parsers.js";
