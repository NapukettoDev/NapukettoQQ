/**
 * grayTip 元素工具（OB11 / Satori 共用，2026-08-08 克隆合并）
 *
 * grayTip（系统提示消息）涉及的操作者/成员 uid 需要批量 uid→uin 转换，
 * 两协议翻译层共用同一套收集逻辑。
 */
import type { GrayTipElement, RawMessage } from "@napuketto/kernel";

/** 非空 uid 才加入集合。 */
function collectUids(uids: Set<string>, ...candidates: Array<string | undefined>): void {
    for (const uid of candidates) {
        if (uid !== undefined && uid !== "") {
            uids.add(uid);
        }
    }
}

/** 收集 grayTip 涉及的 uid（批量 uidToUin 用）。 */
export function collectGrayTipUids(msg: RawMessage): string[] {
    const uids = new Set<string>();
    for (const el of msg.elements) {
        const g = el.grayTipElement;
        if (g === undefined) {
            continue;
        }
        collectUids(uids, g.revokeElement?.operatorUid, g.aioOpGrayTipElement?.peerUid);
        const grp = g.groupElement;
        if (grp === undefined) {
            continue;
        }
        collectUids(
            uids,
            grp.memberUid,
            grp.adminUid,
            grp.shutUp?.admin?.uid,
            grp.shutUp?.member?.uid,
        );
    }
    return [...uids];
}

/**
 * 第一条「已挂载但不可翻译」的 grayTip 元素（校准日志入口）。
 * 与 OB11 / Milky notice 翻译共用：翻译函数返回 null 时用本函数定位元素打 raw
 * 日志，两协议的日志口径一致（跳过 REVOKE——撤回翻译独立成事件）。
 */
export function firstUntranslatedGrayTip(msg: RawMessage): GrayTipElement | undefined {
    for (const el of msg.elements) {
        const g = el.grayTipElement;
        if (g !== undefined && g.revokeElement === undefined) {
            return g;
        }
    }
    return undefined;
}
