/**
 * peer_pin_change 翻译（Milky 批次三，RecentContact/onRecentContactListChangedVer2）
 *
 * 回调随消息活动高频快照（含 topFlag 的全量条目 + chatType=7 影子条目），
 * 不能见条目就广播——按「同会话 topFlag 前后值翻转」检测（PinWatch）。
 * 启动期以 getPinnedContacts 播种基线（重启后首个取消置顶也能观测到）。
 *
 * 证据：2026-11-01 set_peer_pin 自触发翻转实验——changedList 条目
 * {chatType, peerUin, topFlag(1/0), topFlagTime(秒级 unix 字符串)}，与操作
 * 一一对应（milky.md §0.8.6）。
 */
import { ChatType, type PinnedContact, type RecentContact } from "@napuketto/kernel";
import type { PeerPinChangeData } from "../../types.js";

/** uin 形判别（peer_id 必须是数字串）。 */
const NUMERIC_RE = /^\d+$/;

/** 置顶翻转检测（每适配器实例一份，键 = chatType:peerUin——群号与 uin 数值空间可重叠）。 */
export class PinWatch {
    private readonly states = new Map<string, number>();

    /** 启动基线：置顶会话播种（只记状态，不产生事件）。 */
    seed(pins: readonly PinnedContact[]): void {
        for (const pin of pins) {
            if (pin.peerUin === undefined || pin.peerUin === "") {
                continue;
            }
            const chatType = pin.scene === "group" ? ChatType.GROUP : ChatType.C2C;
            this.states.set(`${chatType}:${pin.peerUin}`, 1);
        }
    }

    /**
     * 观测一个变更条目：topFlag 相对上次观测翻转 → true（应广播）；
     * 首见（基线未建立）或未变 → false。
     */
    observe(chatType: number, peerUin: string, topFlag: number): boolean {
        const key = `${chatType}:${peerUin}`;
        const prev = this.states.get(key);
        this.states.set(key, topFlag);
        return prev !== undefined && prev !== topFlag;
    }
}

/** 场景映射（changedList 条目 chatType → Milky message_scene；影子/其他类型丢弃）。 */
export function pinScene(chatType: number): "friend" | "group" | null {
    if (chatType === ChatType.GROUP) {
        return "group";
    }
    if (chatType === ChatType.C2C) {
        return "friend";
    }
    return null;
}

/** 变更条目 → 事件载荷（null = 条目不含置顶字段/场景不支持，跳过不广播）。 */
export function toPeerPinChangeData(
    entry: RecentContact,
): { data: PeerPinChangeData; topFlagTime: string | undefined; peerUin: string } | null {
    const scene = pinScene(entry.chatType);
    if (scene === null || entry.topFlag === undefined) {
        return null;
    }
    // peer_id 必须是 uin：条目 peerUin 优先；群场景 peerUid 恰为群号可兜底，
    // 好友场景 peerUid 是 uid（u_ 形）不可用——缺失即跳过（不硬造 0）。
    const peerUin =
        typeof entry.peerUin === "string" && entry.peerUin !== ""
            ? entry.peerUin
            : scene === "group"
              ? entry.peerUid
              : "";
    if (peerUin === "" || !NUMERIC_RE.test(peerUin)) {
        return null;
    }
    return {
        data: {
            message_scene: scene,
            peer_id: Number(peerUin),
            is_pinned: entry.topFlag === 1,
        },
        topFlagTime: typeof entry.topFlagTime === "string" ? entry.topFlagTime : undefined,
        peerUin,
    };
}
