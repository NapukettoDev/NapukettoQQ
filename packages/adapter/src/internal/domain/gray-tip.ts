/**
 * 系统提示（grayTip）的操作者和成员 uid 在协议边界批量转换为 uin。
 * Linux 会把缺失的变体置为 `null`，元素和子元素都按空值判定是否存在。
 */
import type { GrayTipElement, RawMessage } from "@napuketto/kernel";

export function hasGrayTip(msg: RawMessage): boolean {
    return msg.elements.some((el) => el.grayTipElement != null);
}

function collectUids(uids: Set<string>, ...candidates: Array<string | null | undefined>): void {
    for (const uid of candidates) {
        if (uid != null && uid !== "") {
            uids.add(uid);
        }
    }
}

export function collectGrayTipUids(msg: RawMessage): string[] {
    const uids = new Set<string>();
    for (const el of msg.elements) {
        const g = el.grayTipElement;
        if (g == null) {
            continue;
        }
        collectUids(uids, g.revokeElement?.operatorUid, g.aioOpGrayTipElement?.peerUid);
        const grp = g.groupElement;
        if (grp == null) {
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

/** 通知翻译未命中时定位原始元素供日志使用。撤回由独立事件处理。 */
export function firstUntranslatedGrayTip(msg: RawMessage): GrayTipElement | undefined {
    for (const el of msg.elements) {
        const g = el.grayTipElement;
        if (g != null && g.revokeElement == null) {
            return g;
        }
    }
    return undefined;
}

export function findRevokeElement(
    msg: RawMessage,
): NonNullable<GrayTipElement["revokeElement"]> | undefined {
    return (
        msg.elements.find((el) => el.grayTipElement?.revokeElement != null)?.grayTipElement
            ?.revokeElement ?? undefined
    );
}
