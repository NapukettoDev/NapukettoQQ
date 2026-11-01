/**
 * RecentContactService listener 接口（录制实证，2026-11-01）
 *
 * 方法名来自 wrapper.node 字符串簇 + listener 录制器实测（proxy-listener 三轮
 * 录制，`docs/protocols/milky.md` §0.8.5/§0.8.6）；参数形状按录制产物收窄。
 * 用 type 别名（非 interface）：需满足 ListenerShape（Record<string, unknown>）
 * 约束——与 MsgListener 同模式。
 */
import type { RecentContact } from "../services/recent-contact-service.js";

/** 会话列表变更（onRecentContactListChangedVer2 参数项，录制实证形状）。 */
export interface RecentContactListChanged {
    /** 列表类别（实测 1/2 两类；翻译侧不依赖，用条目 chatType 判场景）。 */
    listType?: number;
    /** 全量排序联系人 id（contactId 空间）。 */
    sortedContactList?: string[];
    /** 变更条目（RecentContact 快照，含 topFlag/topFlagTime/chatType）。 */
    changedList?: RecentContact[];
    [key: string]: unknown;
}

/** 会话列表服务（RecentContactService）的原生回调监听接口。 */
export type RecentContactListener = {
    /** 会话列表变更（高频：消息活动快照 + 置顶翻转，订阅方按 topFlag 翻转过滤）。 */
    onRecentContactListChangedVer2: (lists: RecentContactListChanged[]) => void;
    /** 会话通知（单条快照数组，peerUid 空 / chatType=7 影子条目须过滤）。 */
    onRecentContactNotification: (contacts: RecentContact[]) => void;
};
