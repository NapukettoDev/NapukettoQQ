/**
 * GroupNotifyApi：群通知/禁言列表语义化 API（ADR-009 统一错误语义，P2-13）
 *
 * get_group_system_msg / set_group_add_request / get_group_shut_list 共用。
 * getSingleScreenNotifies / getGroupShutUpMemberList 的列表可能走 listener 回调，
 * 直接调用返回形状待探测校准：兼容 result 数组 / 字段 / Map。
 *
 * 列表提取一律走元素级类型守卫（`isGroupNotify` / `isGroupMember`）：
 * 原生返回数组里混入 null / 字符串 / 残缺对象时逐项丢弃，而不是整数组强转。
 */
import type {
    GroupMember,
    GroupNotify,
    NodeIKernelGroupService,
    NodeIQQNTWrapperSession,
    NTGroupRequestOperateTypes,
} from "../types/index.js";
import {
    hasNumberProp,
    hasStringProp,
    isRecord,
    requireKernelService,
} from "../utils/type-guards.js";
import { unwrap } from "./result.js";

/** 群通知 API：从 session 拿 group service，包装成语义化方法。 */
export class GroupNotifyApi {
    private readonly service: NodeIKernelGroupService;

    constructor(session: NodeIQQNTWrapperSession) {
        this.service = requireKernelService(session.getGroupService(), "getGroupService", [
            "getSingleScreenNotifies",
            "operateSysNotify",
        ]);
    }

    /** 单屏通知列表（get_group_system_msg / set_group_add_request 共用）。 */
    async getSingleScreenNotifies(doubt: boolean, count: number): Promise<GroupNotify[]> {
        const raw: unknown = await this.service.getSingleScreenNotifies(doubt, "", count);
        return extractNotifyList(isRecord(raw) ? raw["result"] : undefined);
    }

    /** 禁言成员列表（get_group_shut_list）。 */
    async getGroupShutUpMemberList(groupCode: string): Promise<GroupMember[]> {
        const raw: unknown = await this.service.getGroupShutUpMemberList(groupCode);
        if (!isRecord(raw)) {
            return [];
        }
        unwrap(
            "getGroupShutUpMemberList",
            typeof raw["result"] === "number" ? raw["result"] : 0,
            typeof raw["errMsg"] === "string" ? raw["errMsg"] : undefined,
        );
        return extractMemberList(raw["result"]);
    }

    /** 处理群请求（set_group_add_request 应答；approve=true 同意 / false 拒绝）。 */
    async handleGroupRequest(
        doubt: boolean,
        notify: GroupNotify,
        operateType: NTGroupRequestOperateTypes,
        reason: string,
    ): Promise<void> {
        const { group, seq, type } = notify;
        let groupCode = "";
        if (group !== undefined) {
            ({ groupCode } = group);
        }
        let postscript = reason;
        if (postscript === "") {
            postscript = " ";
        }
        await this.service.operateSysNotify(doubt, {
            operateType,
            targetMsg: {
                seq,
                type,
                groupCode,
                postscript,
            },
        });
    }
}

/** 群通知项形状判定（seq 字符串 + type 数字是 GroupNotify 的必备标识）。 */
function isGroupNotify(val: unknown): val is GroupNotify {
    return isRecord(val) && hasStringProp(val, "seq") && hasNumberProp(val, "type");
}

/** 可选字段：缺失（undefined/null）放行，存在时必须是 string。 */
function isOptionalString(rec: Record<string, unknown>, key: string): boolean {
    const v = rec[key];
    return v === undefined || v === null || typeof v === "string";
}

/** 可选字段：缺失放行，存在时必须是有限 number。 */
function isOptionalNumber(rec: Record<string, unknown>, key: string): boolean {
    const v = rec[key];
    return v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));
}

/** 群成员项形状判定（uid + uin 必备；展示 / 角色字段缺失即合法，存在则须类型正确）。 */
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
        isOptionalNumber(val, "shutUpTime")
    );
}

/** 数组逐项守卫过滤（非数组 = 空数组）。 */
function filterList<T>(value: unknown, guard: (item: unknown) => item is T): T[] {
    return Array.isArray(value) ? value.filter(guard) : [];
}

/** 从 getSingleScreenNotifies 返回提取通知数组（兼容 result 数组 / notifies / groupNotifies）。 */
export function extractNotifyList(result: unknown): GroupNotify[] {
    if (Array.isArray(result)) {
        return result.filter(isGroupNotify);
    }
    if (!isRecord(result)) {
        return [];
    }
    return [
        ...filterList(result["notifies"], isGroupNotify),
        ...filterList(result["groupNotifies"], isGroupNotify),
    ];
}

/** 从 getGroupShutUpMemberList 返回提取成员数组（兼容 result 数组 / memberList / list / infos Map）。 */
export function extractMemberList(result: unknown): GroupMember[] {
    if (Array.isArray(result)) {
        return result.filter(isGroupMember);
    }
    if (!isRecord(result)) {
        return [];
    }
    const fromFields = [
        ...filterList(result["memberList"], isGroupMember),
        ...filterList(result["list"], isGroupMember),
    ];
    if (fromFields.length > 0) {
        return fromFields;
    }
    const infos = result["infos"];
    if (infos instanceof Map) {
        const out: GroupMember[] = [];
        for (const item of infos.values()) {
            if (isGroupMember(item)) {
                out.push(item);
            }
        }
        return out;
    }
    return [];
}
