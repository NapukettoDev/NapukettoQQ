/**
 * action 域测试公共设施：kernel api 桩构造与固定 ID 映射（避免跨文件克隆同构 setup）。
 *
 * 约定：
 * - uin↔uid 桩映射固定：90001↔u90001、90002↔u90002、90009↔u90009（断言写具体值）。
 * - 动作经领域工厂构造（不经注册表），按名取出后统一走 handle() /
 *   websocketHandle()（zod 校验 + 错误映射）——动作的行为面就是「参数映射 +
 *   返回值映射 + 错误映射」。
 * - 覆盖项显式传 undefined 表示「该字段缺失」（exactOptionalPropertyTypes 友好）。
 */
import { type GroupMember, type GroupNotify, NTGroupMemberRole } from "@napuketto/kernel";
import { type Mock, vi } from "vitest";
import type { ActionResult, Ob11Action } from "../base-action.js";

/** 测试视角的动作（handle / websocketHandle 返回 R；与工厂动作形状同构）。 */
export interface Ob11TestAction<R> {
    readonly name: string;
    handle(payload: unknown): Promise<ActionResult<R>>;
    websocketHandle(payload: unknown, echo?: unknown): Promise<ActionResult<R>>;
}

/**
 * 按动作名从领域工厂产物中取动作（未注册即抛错，防静默漏测）。
 * `R` = 动作返回类型，由用例按动作签名标注，恢复强类型断言面。
 */
export function ob11ActionOf<R>(actions: Ob11Action[], name: string): Ob11TestAction<R> {
    const action = actions.find((a) => a.name === name);
    if (action === undefined) {
        throw new Error(`动作未注册: ${name}`);
    }
    return action as Ob11TestAction<R>;
}

/** 固定 uid↔uin 桩映射（两个方向的表驱动来源）。 */
const UIN_BY_UID: Record<string, string> = {
    u90001: "90001",
    u90002: "90002",
    u90009: "90009",
};

/** uin → uid 桩（查不到原样返回 uin，模拟 QQ 端宽容行为；经 stubConverters 消费）。 */
function stubUinToUid(): Mock<(uins: string[]) => Promise<Map<string, string>>> {
    return vi.fn(async (uins: string[]) => {
        const map = new Map<string, string>();
        for (const uin of uins) {
            const uid = `u${uin}`;
            if (uid in UIN_BY_UID) {
                map.set(uin, uid);
            }
        }
        return map;
    });
}

/** uid → uin 桩（查不到原样返回 uid）。 */
export function stubUidToUin(): Mock<(uids: string[]) => Promise<Map<string, string>>> {
    return vi.fn(async (uids: string[]) => {
        const map = new Map<string, string>();
        for (const uid of uids) {
            const uin = UIN_BY_UID[uid];
            if (uin !== undefined) {
                map.set(uid, uin);
            } else {
                map.set(uid, uid);
            }
        }
        return map;
    });
}

/** 一对固定映射的转换桩（uinToUid 在前）。 */
export function stubConverters(): {
    uinToUid: Mock<(uins: string[]) => Promise<Map<string, string>>>;
    uidToUin: Mock<(uids: string[]) => Promise<Map<string, string>>>;
} {
    return { uinToUid: stubUinToUid(), uidToUin: stubUidToUin() };
}

/** 覆盖项类型：字段可显式 undefined（表示缺失），展开时过滤掉 undefined。 */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

/** 展开覆盖项：显式 undefined = 删除该字段（缺失形态），其余覆盖。 */
function applyOverrides<T extends object>(base: T, overrides: Overrides<T>): T {
    const out = { ...base } as unknown as Record<string, unknown>;
    for (const key of Object.keys(overrides)) {
        const value = (overrides as Record<string, unknown>)[key];
        if (value === undefined) {
            delete out[key];
        } else {
            out[key] = value;
        }
    }
    return out as T;
}

/** 构造 GroupMember 桩（缺省最小合法值；覆盖项允许显式 undefined）。 */
export function makeMember(overrides: Overrides<GroupMember> = {}): GroupMember {
    return applyOverrides(
        {
            uid: "u90001",
            uin: "90001",
            nick: "小明",
            cardName: "",
            remark: "",
            role: NTGroupMemberRole.MEMBER,
            shutUpTime: 0,
            joinTime: "",
            lastSpeakTime: "",
        },
        overrides,
    );
}

/** 构造 GroupNotify 桩（缺省 = 未处理入群申请；覆盖项允许显式 undefined）。 */
export function makeNotify(overrides: Overrides<GroupNotify> = {}): GroupNotify {
    return applyOverrides(
        {
            seq: "88001",
            type: 7,
            status: 1,
            group: { groupCode: "808", groupName: "测试群" },
            user1: { uid: "u90002", nickName: "申请人" },
            postscript: "求入群",
        },
        overrides,
    );
}
