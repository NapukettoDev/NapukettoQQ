/**
 * media-patch-status.test.ts：stub 补丁状态读取（issue #105 P2.1）。
 * 覆盖：文件缺失 / 坏 JSON / 非对象 / 合法状态返回。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { readMediaPatchStatus } from "../media-patch-status.js";

let tmp = "";
afterAll(() => {
    if (tmp !== "") {
        rmSync(tmp, { recursive: true, force: true });
    }
});

describe("readMediaPatchStatus", () => {
    it("状态文件缺失 → undefined", () => {
        tmp = mkdtempSync(join(tmpdir(), "napuketto-mps-"));
        expect(readMediaPatchStatus(join(tmp, "missing.json"))).toBeUndefined();
    });

    it("坏 JSON → undefined（不抛）", () => {
        tmp = mkdtempSync(join(tmpdir(), "napuketto-mps-"));
        const path = join(tmp, "bad.json");
        writeFileSync(path, "{not json");
        expect(readMediaPatchStatus(path)).toBeUndefined();
    });

    it("非对象（数组 / 字符串）→ undefined", () => {
        tmp = mkdtempSync(join(tmpdir(), "napuketto-mps-"));
        const arr = join(tmp, "arr.json");
        writeFileSync(arr, "[1,2]");
        expect(readMediaPatchStatus(arr)).toBeUndefined();
        const str = join(tmp, "str.json");
        writeFileSync(str, '"applied"');
        expect(readMediaPatchStatus(str)).toBeUndefined();
    });

    it("合法状态 → 字段原样返回", () => {
        tmp = mkdtempSync(join(tmpdir(), "napuketto-mps-"));
        const path = join(tmp, "ok.json");
        writeFileSync(
            path,
            '{"v":1,"state":"applied","componentA":"applied","componentB":"applied","cleared":1,"tick":1}',
        );
        expect(readMediaPatchStatus(path)).toEqual({
            v: 1,
            state: "applied",
            componentA: "applied",
            componentB: "applied",
            cleared: 1,
            tick: 1,
        });
    });
});
