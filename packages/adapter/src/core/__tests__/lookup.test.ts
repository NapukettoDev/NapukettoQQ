/**
 * core/lookup 基线测试（milky api 与 satori action 的通知/申请查找共用骨架）
 *
 * 锁定 findFirstMatch：屏序惰性拉取（前一屏命中不拉后续屏）/ 谓词首个命中 /
 * 全部未命中 undefined（错误语义归调用方，本函数不抛业务错）。
 */
import { describe, expect, it, vi } from "vitest";
import { findFirstMatch } from "../shared/lookup.js";

describe("findFirstMatch", () => {
    it("首屏命中：不拉后续屏（群通知先非可疑后可疑的规范序）", async () => {
        const doubtFetcher = vi.fn(async () => [{ seq: "9", value: "doubt" }]);
        const hit = await findFirstMatch(
            [async () => [{ seq: "1", value: "normal" }], doubtFetcher],
            (item) => item.seq === "1",
        );
        expect(hit).toEqual({ seq: "1", value: "normal" });
        expect(doubtFetcher).not.toHaveBeenCalled();
    });

    it("首屏未命中：依序拉下一屏", async () => {
        const hit = await findFirstMatch(
            [async () => [{ seq: "1" }], async () => [{ seq: "2" }]],
            (item) => item.seq === "2",
        );
        expect(hit).toEqual({ seq: "2" });
    });

    it("全部未命中：返回 undefined（不抛错）", async () => {
        const hit = await findFirstMatch(
            [async () => [{ seq: "1" }], async () => [{ seq: "2" }]],
            () => false,
        );
        expect(hit).toBeUndefined();
    });

    it("空候选屏列表：返回 undefined", async () => {
        expect(await findFirstMatch([], () => true)).toBeUndefined();
    });

    it("拉取抛错：异常向上传播（错误语义归调用方）", async () => {
        await expect(
            findFirstMatch(
                [
                    async () => {
                        throw new Error("列表拉取失败");
                    },
                ],
                () => true,
            ),
        ).rejects.toThrow("列表拉取失败");
    });
});
