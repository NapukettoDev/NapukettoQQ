/**
 * GroupApi 的原始响应守卫与解析：原生 wrapper 返回形状不稳定，这里集中做形状收窄
 * 与宽松提取，业务方法只消费解析结果（错误仍由调用方抛 KernelError）。
 */
import { hasNumberProp, hasStringProp, isRecord, kernelError } from "../../infra/index.js";
import type { GroupBulletin, GroupDetailInfo, GroupMember } from "../../types/index.js";

/** result 字段宽松取数（数字直接用，缺省 0 = 成功语义）。 */
export function toResultNumber(result: unknown): number {
    return typeof result === "number" ? result : 0;
}

/** 未知值 → string | undefined（非字符串一律丢弃）。 */
export function toOptionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** 字符串键值 Map 收窄（非 Map / 非 string 项丢弃，不做元素级强转）。 */
export function toStringMap(value: unknown): Map<string, string> {
    const out = new Map<string, string>();
    if (!(value instanceof Map)) {
        return out;
    }
    for (const [key, val] of value) {
        if (typeof key === "string" && typeof val === "string") {
            out.set(key, val);
        }
    }
    return out;
}

/** 可选字段：缺失（undefined/null）放行，存在时必须是 string。 */
function isOptionalString(rec: Record<string, unknown>, key: string): boolean {
    const v = rec[key];
    return v === undefined || v === null || typeof v === "string";
}

/** 可选字段：缺失（undefined/null）放行，存在时必须是有限 number。 */
function isOptionalNumber(rec: Record<string, unknown>, key: string): boolean {
    const v = rec[key];
    return v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));
}

/** 群成员形状判定（uid + uin 必备；展示 / 角色字段缺失即合法，存在则须类型正确）。 */
function isGroupMember(val: unknown): val is GroupMember {
    return (
        isRecord(val) &&
        hasStringProp(val, "uid") &&
        hasStringProp(val, "uin") &&
        isOptionalString(val, "nick") &&
        isOptionalString(val, "cardName") &&
        isOptionalString(val, "remark") &&
        isOptionalString(val, "joinTime") &&
        isOptionalString(val, "lastSpeakTime") &&
        isOptionalNumber(val, "role") &&
        isOptionalNumber(val, "shutUpTime") &&
        isOptionalNumber(val, "sex") &&
        isOptionalNumber(val, "age")
    );
}

/** infos Map → 成员数组（逐项形状校验，非成员项丢弃）。 */
export function memberListOf(infos: Map<unknown, unknown>): GroupMember[] {
    const out: GroupMember[] = [];
    for (const value of infos.values()) {
        if (isGroupMember(value)) {
            out.push(value);
        }
    }
    return out;
}

/** 群详情形状判定（标识 / 名称 / 成员数四要素齐备；群号标识字段可选校验）。 */
function isGroupDetailInfo(val: unknown): val is GroupDetailInfo {
    return (
        isRecord(val) &&
        hasStringProp(val, "groupCode") &&
        hasStringProp(val, "groupName") &&
        hasNumberProp(val, "memberNum") &&
        hasNumberProp(val, "maxMemberNum") &&
        isOptionalString(val, "groupUin") &&
        isOptionalString(val, "ownerUin")
    );
}

/**
 * 从 getAllMemberList 返回结构取出 infos Map。
 * 兼容 `{ infos }` 与 `{ result: { infos } }` 两种形状（探测期二者都出现过）；
 * 错误码非 0 抛 UNKNOWN，缺 infos 抛 INVALID_PARAM。
 */
export function extractMemberInfos(raw: unknown): Map<unknown, unknown> {
    if (!isRecord(raw)) {
        throw kernelError("getAllMemberList 返回格式无效（非对象）", "INVALID_PARAM");
    }
    const code = toResultNumber(raw["errCode"]);
    if (code !== 0) {
        const msg = toOptionalString(raw["errMsg"]) ?? "未知错误";
        throw kernelError(`getAllMemberList 失败 (code=${code}): ${msg}`, "UNKNOWN");
    }
    const infos = raw["infos"];
    if (infos instanceof Map) {
        return infos;
    }
    const nested = raw["result"];
    if (isRecord(nested)) {
        const nestedInfos = nested["infos"];
        if (nestedInfos instanceof Map) {
            return nestedInfos;
        }
    }
    throw kernelError("getAllMemberList 返回结果缺失 infos Map", "INVALID_PARAM");
}

/** 公告列表宽松提取（result 数组 / { bulletins } / { result: 数组 } 兼容，形状待校准）。 */
export function extractBulletins(result: unknown): GroupBulletin[] {
    const candidates: unknown[] = [result];
    if (isRecord(result)) {
        for (const key of ["bulletins", "announcementList", "result", "list"] as const) {
            candidates.push(result[key]);
        }
    }
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            return candidate.filter(isRecord);
        }
    }
    return [];
}

/**
 * 从 getGroupDetailInfo 返回提取群详情（兼容三种形状）：
 *  - result 为详情对象 → 直接返回
 *  - result 为 0/空 → 从 raw.groupInfo / detailInfo / info 提取
 * 提取不到（含数组 / 空对象 / 缺字段）返回 null，由调用方抛 KernelError。导出供单测。
 */
export function extractGroupDetail(result: unknown, raw: unknown): GroupDetailInfo | null {
    if (isGroupDetailInfo(result)) {
        return result;
    }
    if (!isRecord(raw)) {
        return null;
    }
    const candidate = raw["groupInfo"] ?? raw["detailInfo"] ?? raw["info"];
    return isGroupDetailInfo(candidate) ? candidate : null;
}
