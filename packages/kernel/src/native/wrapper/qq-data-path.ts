/**
 * QQ 数据根路径解析（P2-1，2026-08-06）
 *
 * 从 `getNTUserDataInfoConfig()` 的返回值中提取 QQ 真实数据根路径：
 * worker（utilityProcess）模式下 loginService 是 new 的，commonPath 必须指向
 * QQ 真实数据路径才能读到历史账号（cli 的 `.napuketto\default` 读不到，
 * getLoginList 空，P2-1 实测）。
 *
 * 返回值形态可能是 JSON 字符串（对象/数组）或纯路径字符串，此处做宽容解析。
 */

import { join } from "node:path";

/**
 * QQ 全局数据目录（commonPath / desktopGlobalPath = 数据根/nt_qq/global，
 * HANDOVER-V6 自建宿主三要素之三，p0-kernel-flow 实证）。
 *
 * 防御：已含 nt_qq/global 后缀（worker 环境下 getNTUserDataInfoConfig 可能
 * 返回完整路径）则不重复拼接，避免 `nt_qq/global/nt_qq/global` 错位。
 */
export function resolveQqGlobalPath(root: string): string {
    const norm = root.replace(/\\/g, "/");
    if (norm.endsWith("/nt_qq/global")) {
        return root;
    }
    if (norm.endsWith("/nt_qq")) {
        return join(root, "global");
    }
    return join(root, "nt_qq", "global");
}

/** 从 getNTUserDataInfoConfig 返回值提取数据根（JSON 字符串解析或纯路径）。 */
export function extractDataRoot(raw: string): string | null {
    if (raw.startsWith("{") || raw.startsWith("[")) {
        try {
            return findPathInValue(JSON.parse(raw));
        } catch {
            return null;
        }
    }
    return raw;
}

/** 递归在对象/数组里找含 QQ 数据路径特征的字符串值。 */
function findPathInValue(value: unknown): string | null {
    if (typeof value === "string") {
        return isQqDataPath(value) ? value : null;
    }
    if (Array.isArray(value)) {
        return findInArray(value);
    }
    if (typeof value === "object" && value !== null) {
        return findInObject(value);
    }
    return null;
}

/** 判断字符串是否含 QQ 数据路径特征。 */
function isQqDataPath(value: string): boolean {
    return value.includes("Tencent Files") || value.includes("nt_qq");
}

/** 在数组里递归查找。 */
function findInArray(value: unknown[]): string | null {
    for (const item of value) {
        const found = findPathInValue(item);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

/** 在对象值里递归查找。 */
function findInObject(value: object): string | null {
    for (const v of Object.values(value)) {
        const found = findPathInValue(v);
        if (found !== null) {
            return found;
        }
    }
    return null;
}
