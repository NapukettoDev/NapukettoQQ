/**
 * 陌生人信息扁平化纯函数（get_stranger_info 的数据映射部分）
 *
 * 2026-08-08 从 profile.ts 拆出：NAPI 会话依赖（ProfileApi）与纯映射分离，
 * 纯函数可独立单测（stranger-info.test.ts 基线锁定宽松取值行为）。
 *
 * 宽松取值：优先 info（uid 完整详情），字段缺失回退 byUin（uin 初查详情），
 * 两份都缺给默认值——字段缺失是 QQ 详情接口的常态，不能抛错。
 */
import type { UserDetailInfoByUin } from "../../types/index.js";

/** 陌生人信息（get_stranger_info 返回）。 */
export interface StrangerInfo {
    user_id: number;
    uid: string;
    nickname: string;
    age: number;
    qid: string;
    qq_level: number;
    sex: "male" | "female" | "unknown";
    long_nick: string;
    reg_time: number;
    is_vip: boolean;
    is_years_vip: boolean;
    vip_level: number;
    remark: string;
    status: number;
    login_days: number;
}

/** 扁平化后的详情视图（双来源字段级回退的产物，仅含 StrangerInfo 需要的字段）。 */
interface MergedDetail {
    coreInfo?: { nick?: string; remark?: string } | undefined;
    baseInfo?: { age?: number; qid?: string; sex?: number; longNick?: string } | undefined;
    vasInfo?: { svipFlag?: boolean; yearVipFlag?: boolean; vipLevel?: number } | undefined;
    commonExt?: { qqLevel?: number; regTime?: number } | undefined;
    status?: number | undefined;
}

/** 宽松取值：undefined 时给默认值（null 也归默认）。 */
function orDefault<T>(value: T | undefined, fallback: T): T {
    return value ?? fallback;
}

/** 合并两份详情：优先 info（uid 完整详情），字段缺失回退 byUin（uin 初查详情）。 */
function mergeDetail(info: UserDetailInfoByUin, byUin: UserDetailInfoByUin): MergedDetail {
    const infoSimple = info.detail?.simpleInfo;
    const byUinSimple = byUin.detail?.simpleInfo;
    return {
        coreInfo: pickField(infoSimple, byUinSimple, (s) => s?.coreInfo),
        baseInfo: pickField(infoSimple, byUinSimple, (s) => s?.baseInfo),
        vasInfo: pickField(infoSimple, byUinSimple, (s) => s?.vasInfo),
        commonExt: pickField(info.detail, byUin.detail, (d) => d?.commonExt),
        status: pickField(infoSimple, byUinSimple, (s) => s?.status?.status),
    };
}

/** 字段级回退：primary 的字段取不到回退 fallback 的同名字段（宽松取值）。 */
function pickField<T, R>(
    primary: T | undefined,
    fallback: T | undefined,
    get: (src: T) => R | undefined,
): R | undefined {
    const fromPrimary = primary !== undefined ? get(primary) : undefined;
    if (fromPrimary !== undefined) {
        return fromPrimary;
    }
    return fallback !== undefined ? get(fallback) : undefined;
}

/** 扁平化两份详情 → StrangerInfo（宽松取值，字段缺失给默认）。 */
export function flattenStrangerInfo(
    uin: string,
    uid: string,
    byUin: UserDetailInfoByUin,
    info: UserDetailInfoByUin,
): StrangerInfo {
    const d = mergeDetail(info, byUin);
    return {
        user_id: Number(uin),
        uid,
        nickname: orDefault(d.coreInfo?.nick, ""),
        age: orDefault(d.baseInfo?.age, 0),
        qid: orDefault(d.baseInfo?.qid, ""),
        qq_level: orDefault(d.commonExt?.qqLevel, 0),
        sex: mapSex(d.baseInfo?.sex),
        long_nick: orDefault(d.baseInfo?.longNick, ""),
        reg_time: orDefault(d.commonExt?.regTime, 0),
        is_vip: orDefault(d.vasInfo?.svipFlag, false),
        is_years_vip: orDefault(d.vasInfo?.yearVipFlag, false),
        vip_level: orDefault(d.vasInfo?.vipLevel, 0),
        remark: orDefault(d.coreInfo?.remark, ""),
        status: orDefault(d.status, 0),
        login_days: 0,
    };
}

/** 性别数值 → OB11 字符串（1=男 2=女 其余 unknown）。 */
function mapSex(raw: number | undefined): "male" | "female" | "unknown" {
    if (raw === 1) {
        return "male";
    }
    if (raw === 2) {
        return "female";
    }
    return "unknown";
}
