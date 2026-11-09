/**
 * wrapper-config.ts build 系列测试（基线 parseAppidFromMajor/readMachineGuid 之外）：
 *  - buildEngineConfig：字段契约（appid / qua / os_version 探测 / thumb_config）+
 *    major.node 缺失抛错
 *  - buildLoginConfig：externalVersion=false 扫码兼容关键 + commonPath 透传
 *  - buildSessionConfig：deviceInfo 组装 / deviceConfig JSON 字符串 / platform 契约
 *  - systemInfo 兜底：devType 平台映射不写死构建号
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformType, VendorType } from "../../types/index.js";
import {
    buildEngineConfig,
    buildLoginConfig,
    buildSessionConfig,
    parseAppidFromMajor,
    resolveAppidQua,
} from "../wrapper-config.js";

// readFileSync 包一层可 mock 的 spy（默认透传，仅「读失败」用例覆写）
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const tmpDirs: string[] = [];
afterAll(() => {
    for (const dir of tmpDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** 造一个含 QQAppId/ 标记的假 major.node（extra 可附 qua 等字符串）。 */
function fakeMajor(extra: string[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), "nk-test-major-"));
    tmpDirs.push(dir);
    const p = join(dir, "major.node");
    const marker = Buffer.from("QQAppId/", "utf-8");
    const payload = Buffer.concat([
        Buffer.alloc(64, 0),
        marker,
        Buffer.from("537376818\0junk"),
        Buffer.alloc(32, 0),
        ...extra.map((s) => Buffer.from(`${s}\0`, "utf-8")),
        Buffer.alloc(32, 0),
    ]);
    writeFileSync(p, payload);
    return p;
}

describe("buildEngineConfig", () => {
    it("字段契约：appid 来自 major.node / qua 按平台拼接 / thumb_config 固定值", () => {
        const cfg = buildEngineConfig("9.9.33-51802", "C:/gp", fakeMajor(), PlatformType.KWINDOWS);
        expect(cfg["app_version"]).toBe("9.9.33-51802");
        expect(cfg["qua"]).toBe("V1_WIN_NQ_9.9.33-51802_GW_B");
        expect(cfg["app_type"]).toBe(4);
        expect(cfg["platform_type"]).toBe(PlatformType.KWINDOWS);
        expect(cfg["use_xlog"]).toBe(true);
        expect(cfg["global_path_config"]).toEqual({ desktopGlobalPath: "C:/gp" });
        expect(cfg["thumb_config"]).toEqual({
            maxSide: 324,
            minSide: 48,
            longLimit: 6,
            density: 2,
        });
        // os_version 来自运行时探测（非写死构建号）
        expect(typeof cfg["os_version"]).toBe("string");
        expect(cfg["os_version"]).not.toContain("10.0.22631");
    });

    it("Linux：platform=KLINUX / qua 取 major.node 内嵌 V1_LNX 值", () => {
        const cfg = buildEngineConfig(
            "3.2.35-54395",
            "/data/global",
            fakeMajor(["V1_LNX_NQ_3.2.35_54395_GW_B"]),
            PlatformType.KLINUX,
        );
        expect(cfg["platform_type"]).toBe(PlatformType.KLINUX);
        expect(cfg["qua"]).toBe("V1_LNX_NQ_3.2.35_54395_GW_B");
        expect(cfg["use_xlog"]).toBe(true);
    });

    it("majorPath 解析失败 → KernelError（不再静默回退过期 appid）", () => {
        expect(() => buildEngineConfig("9.9.33-51802", "C:/gp", "/no/such/major.node")).toThrow(
            /无法从 major.node 解析 appid/,
        );
    });
});

describe("buildLoginConfig", () => {
    it("externalVersion=false（扫码兼容关键）+ machineId 空 + commonPath 透传", () => {
        const cfg = buildLoginConfig("537376818", "9.9.33-51802", "C:/nt_qq/global");
        expect(cfg["externalVersion"]).toBe(false);
        expect(cfg["machineId"]).toBe("");
        expect(cfg["appid"]).toBe("537376818");
        expect(cfg["commonPath"]).toBe("C:/nt_qq/global");
        expect(cfg["clientVer"]).toBe("9.9.33-51802");
        expect(typeof cfg["hostName"]).toBe("string");
        expect(typeof cfg["platVer"]).toBe("string");
    });
});

describe("buildSessionConfig", () => {
    it("deviceInfo 组装：guid 默认空串 / localId 2052 / vendor 契约 / deviceConfig JSON 字符串", () => {
        const cfg = buildSessionConfig({
            appid: "537376818",
            fullVersion: "9.9.33-51802",
            selfUin: "10001",
            selfUid: "u-1",
            accountPath: "C:/acc",
            downloadPath: "C:/dl",
            platform: PlatformType.KWINDOWS,
        });
        expect(cfg["selfUin"]).toBe("10001");
        expect(cfg["selfUid"]).toBe("u-1");
        expect(cfg["desktopPathConfig"]).toEqual({ account_path: "C:/acc" });
        expect(cfg["defaultFileDownloadPath"]).toBe("C:/dl");
        expect(cfg["platform"]).toBe(PlatformType.KWINDOWS);
        expect(cfg["appid"]).toBe("537376818");
        expect(cfg["clientVer"]).toBe("9.9.33-51802");
        const device = cfg["deviceInfo"] as unknown as Record<string, unknown>;
        expect(device["guid"]).toBe("");
        expect(device["localId"]).toBe(2052);
        expect(device["buildVer"]).toBe("9.9.33-51802");
        expect(device["vendorType"]).toBe(VendorType.KNOSETONIOS);
        expect(device["setMute"]).toBe(false);
        expect(typeof device["devType"]).toBe("string");
        // deviceConfig 是 wrapper 契约的 JSON 字符串（非对象）
        const deviceConfig = JSON.parse(cfg["deviceConfig"] as string) as Record<string, unknown>;
        expect(deviceConfig["appearance"]).toEqual({ isSplitViewMode: true });
    });

    it("machineGuid 传入 → deviceInfo.guid 填充", () => {
        const cfg = buildSessionConfig({
            appid: "a",
            fullVersion: "v",
            selfUin: "1",
            selfUid: "u",
            accountPath: "p",
            downloadPath: "d",
            machineGuid: "GUID-1",
        });
        expect((cfg["deviceInfo"] as unknown as Record<string, unknown>)["guid"]).toBe("GUID-1");
    });
});

describe("parseAppidFromMajor 边界", () => {
    beforeEach(async () => {
        const { readFileSync } = await import("node:fs");
        vi.mocked(readFileSync).mockClear();
    });

    it("existsSync 通过但读取失败 → null（不抛错）", async () => {
        const p = fakeMajor();
        const { readFileSync } = await import("node:fs");
        vi.mocked(readFileSync).mockImplementationOnce(() => {
            throw new Error("locked");
        });
        expect(parseAppidFromMajor(p)).toBeNull();
    });

    it("标记后非纯数字且无后续标记 → 扫描耗尽返回 null", () => {
        const dir = mkdtempSync(join(tmpdir(), "nk-test-major-"));
        tmpDirs.push(dir);
        const p = join(dir, "major.node");
        const payload = Buffer.concat([
            Buffer.from("QQAppId/", "utf-8"),
            Buffer.from("not-digits"),
        ]);
        writeFileSync(p, payload);
        expect(parseAppidFromMajor(p)).toBeNull();
    });
});

describe("resolveAppidQua 补充", () => {
    it("fullVersion 无构建号后缀 → qua 只带版本段", () => {
        const { qua } = resolveAppidQua("9.9.33", fakeMajor(), PlatformType.KWINDOWS);
        expect(qua).toBe("V1_WIN_NQ_9.9.33_GW_B");
    });
});
