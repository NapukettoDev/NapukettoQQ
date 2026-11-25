/**
 * core/uid-uin 基线测试（OB11 / Milky request 翻译共享的 uid→uin 解析）
 *
 * 锁定：映射命中 / 未命中退化 uid 数值 / 非数字 0 / 空与 undefined 0；
 * toUin（ctx 便捷形）与 toUinString（satori string 口径）同规则。
 * 另锁定共享的群通知 uid 收集与 `resolveUidToUinWithFallback`（批量 + 资料兜底）：
 * 去重空串 / 批量失败 warn 退空 Map / 兜底上限与逐条 fail-soft debug 留痕。
 */
import type { GroupNotify } from "@napuketto/kernel";
import { GroupNotifyMsgStatus, GroupNotifyMsgType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import type { AdapterLoggerLike } from "../../../src/internal/infra/log.js";
import {
    collectGroupNotifyUids,
    MAX_PROFILE_LOOKUPS,
    resolveUidToUinWithFallback,
    resolveUin,
    toUin,
    toUinString,
} from "../../../src/internal/qq/uid-uin.js";

/** 校准 logger 桩（断言留痕用）。 */
function makeLogger(): AdapterLoggerLike {
    return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

/** 群通知桩（只填本用例关心的字段）。 */
function makeNotify(index: number, user1?: string, user2?: string): GroupNotify {
    return {
        seq: String(index),
        type: GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS,
        status: GroupNotifyMsgStatus.KUNHANDLE,
        ...(user1 !== undefined ? { user1: { uid: user1, nickName: "n1" } } : {}),
        ...(user2 !== undefined ? { user2: { uid: user2, nickName: "n2" } } : {}),
    };
}

describe("resolveUin", () => {
    const map = new Map([
        ["uid-20002", "20002"],
        ["uid-30003", "30003"],
    ]);

    it("映射命中：取 uin 数值", () => {
        expect(resolveUin("uid-20002", map)).toBe(20002);
    });

    it("映射未命中：uid 本身是数字时直取数值（wrapper 部分回调直接给 uin）", () => {
        expect(resolveUin("10001", map)).toBe(10001);
    });

    it("映射未命中且 uid 非数字：返回 0 兜底", () => {
        expect(resolveUin("u_xxxx", map)).toBe(0);
    });

    it("空串 / undefined：返回 0", () => {
        expect(resolveUin("", map)).toBe(0);
        expect(resolveUin(undefined, map)).toBe(0);
    });
});

describe("toUin（ctx 便捷形：OB11 / Milky notice + request 收拢后共用）", () => {
    const ctx = { uidToUin: new Map([["uid-20002", "20002"]]) };

    it("ctx 携带映射：命中取 uin，未命中退化 uid 数值", () => {
        expect(toUin("uid-20002", ctx)).toBe(20002);
        expect(toUin("10001", ctx)).toBe(10001);
    });

    it("非数字 uid 未命中：0 兜底（与 resolveUin 同规则）", () => {
        expect(toUin("u_xxxx", ctx)).toBe(0);
        expect(toUin(undefined, ctx)).toBe(0);
    });
});

describe("toUinString（satori string 口径：资源对象保留协议串）", () => {
    const map = new Map([["uid-20002", "20002"]]);

    it("映射命中：取 uin 字符串原样（不做数值化）", () => {
        expect(toUinString("uid-20002", map)).toBe("20002");
    });

    it("映射未命中：退化 uid 原文", () => {
        expect(toUinString("uid-99999", map)).toBe("uid-99999");
        expect(toUinString("10001", map)).toBe("10001");
    });
});

describe("collectGroupNotifyUids（群通知 user1/user2 双方 uid）", () => {
    it("收集双方 uid，跳过空串与缺失的 user", () => {
        expect(
            collectGroupNotifyUids([
                makeNotify(1, "u-1", "u-2"),
                makeNotify(2, "u-3"),
                makeNotify(3, undefined, "u-4"),
                makeNotify(4, "", ""),
                makeNotify(5),
            ]),
        ).toEqual(["u-1", "u-2", "u-3", "u-4"]);
    });

    it("空列表 → 空数组", () => {
        expect(collectGroupNotifyUids([])).toEqual([]);
    });
});

describe("resolveUidToUinWithFallback（批量 + 资料兜底）", () => {
    it("空输入 / 全空串 → 空 Map，且不触发批量查询与日志", async () => {
        const uidToUin = vi.fn(async () => new Map<string, string>());
        const logger = makeLogger();
        const deps = {
            uidToUin,
            logger,
            scope: "ob11" as const,
            batchWarnMsg: "ob11: batch failed",
        };
        await expect(resolveUidToUinWithFallback([], deps)).resolves.toEqual(new Map());
        await expect(resolveUidToUinWithFallback(["", ""], deps)).resolves.toEqual(new Map());
        expect(uidToUin).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("去重空串后批量转换，返回命中映射", async () => {
        const uidToUin = vi.fn(
            async (uids: string[]) => new Map(uids.map((uid) => [uid, `uin-${uid}`])),
        );
        const map = await resolveUidToUinWithFallback(["u-1", "u-1", "", "u-2"], {
            uidToUin,
            logger: makeLogger(),
            scope: "milky",
            batchWarnMsg: "milky: batch failed",
        });
        expect(uidToUin).toHaveBeenCalledWith(["u-1", "u-2"]);
        expect(map.get("u-1")).toBe("uin-u-1");
        expect(map.get("u-2")).toBe("uin-u-2");
    });

    it("批量转换失败 → warn 留痕并退空 Map", async () => {
        const logger = makeLogger();
        const map = await resolveUidToUinWithFallback(["u-1", "u-2"], {
            uidToUin: async () => {
                throw new Error("boom");
            },
            logger,
            scope: "ob11",
            batchWarnMsg: "ob11: 请求 uid→uin 批量转换失败，退用 uid",
        });
        expect(map.size).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(
            { count: 2, error: "boom" },
            "ob11: 请求 uid→uin 批量转换失败，退用 uid",
        );
    });

    it("未开启 profileFallback：不做逐条资料兜底", async () => {
        const getUinByUid = vi.fn(async () => "99009");
        const map = await resolveUidToUinWithFallback(["u-1"], {
            uidToUin: async () => new Map(),
            getUinByUid,
            logger: makeLogger(),
            scope: "milky",
            batchWarnMsg: "milky: batch failed",
        });
        expect(map.size).toBe(0);
        expect(getUinByUid).not.toHaveBeenCalled();
    });

    it("开启 profileFallback：未命中前 MAX_PROFILE_LOOKUPS 条逐一回填，超限 debug 留痕", async () => {
        const uids = Array.from({ length: MAX_PROFILE_LOOKUPS + 3 }, (_, i) => `u-${i}`);
        const getUinByUid = vi.fn(async (uid: string) => `uin-${uid}`);
        const logger = makeLogger();
        const map = await resolveUidToUinWithFallback(uids, {
            uidToUin: async () => new Map(),
            getUinByUid,
            logger,
            scope: "milky",
            batchWarnMsg: "milky: batch failed",
            profileFallback: true,
        });
        expect(getUinByUid).toHaveBeenCalledTimes(MAX_PROFILE_LOOKUPS);
        expect(map.size).toBe(MAX_PROFILE_LOOKUPS);
        expect(map.get("u-0")).toBe("uin-u-0");
        expect(map.has(`u-${MAX_PROFILE_LOOKUPS}`)).toBe(false);
        expect(logger.debug).toHaveBeenCalledWith(
            { missing: MAX_PROFILE_LOOKUPS + 3, limit: MAX_PROFILE_LOOKUPS },
            "milky: 待兜底 uid 超上限，其余保持未命中",
        );
    });

    it("单条兜底抛错 / 查不到 → debug 留痕，其余继续", async () => {
        const getUinByUid = vi.fn(async (uid: string) => {
            if (uid === "u-boom") {
                throw new Error("boom");
            }
            return uid === "u-null" ? null : "99009";
        });
        const logger = makeLogger();
        const map = await resolveUidToUinWithFallback(["u-boom", "u-null", "u-ok"], {
            uidToUin: async () => new Map(),
            getUinByUid,
            logger,
            scope: "ob11",
            batchWarnMsg: "ob11: batch failed",
            profileFallback: true,
        });
        expect(map.has("u-boom")).toBe(false);
        expect(map.has("u-null")).toBe(false);
        expect(map.get("u-ok")).toBe("99009");
        expect(logger.debug).toHaveBeenCalledWith(
            { error: "boom" },
            "ob11: uid→uin 资料兜底失败（该 uid 退 0）",
        );
    });

    it("批量失败仍继续资料兜底（弱身份场景不因群口径失败而退 0）", async () => {
        const getUinByUid = vi.fn(async () => "99009");
        const map = await resolveUidToUinWithFallback(["u-stranger"], {
            uidToUin: async () => {
                throw new Error("boom");
            },
            getUinByUid,
            logger: makeLogger(),
            scope: "ob11",
            batchWarnMsg: "ob11: batch failed",
            profileFallback: true,
        });
        expect(map.get("u-stranger")).toBe("99009");
    });
});
