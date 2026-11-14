/**
 * grayTip 元素工具（OB11 / Satori 共用，克隆合并）
 *
 * grayTip（系统提示消息）涉及的操作者/成员 uid 需要批量 uid→uin 转换，
 * 两协议翻译层共用同一套收集逻辑。
 */
import type { GrayTipElement, RawMessage } from "@napuketto/kernel";

/**
 * 消息是否含 grayTip 元素（OB11 / Milky 收链路分流判据，收拢）。
 * `!= null` 空值判定：Linux 原生宿主把未命中的变体字段显式置 null，
 * `!== undefined` 会把普通消息误判成 grayTip 消息（见 OB11 hasFileElement 注）。
 */
export function hasGrayTip(msg: RawMessage): boolean {
    return msg.elements.some((el) => el.grayTipElement != null);
}

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

/**
 * 撤回 grayTip 元素（非撤回消息返回 undefined；Milky 收链路 notice/召回
 * 分流判据，自 milky adapter.ts 收拢）。
 */
export function findRevokeElement(
    msg: RawMessage,
): NonNullable<GrayTipElement["revokeElement"]> | undefined {
    return msg.elements.find((el) => el.grayTipElement?.revokeElement != null)?.grayTipElement
        ?.revokeElement;
}
