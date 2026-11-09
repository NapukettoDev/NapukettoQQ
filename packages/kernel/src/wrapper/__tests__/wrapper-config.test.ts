/**
 * wrapper-config.ts parseAppidFromMajor 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖 major.node appid 提取：
 *  - QQAppId/ 标记后纯数字串提取
 *  - 多个标记取第一个纯数字
 *  - 文件不存在 / 读取失败 → null
 */
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KernelError } from "../../infra/index.js";
import {
    buildSessionConfig,
    parseAppidFromMajor,
    readMachineGuid,
    resolveAppidQua,
} from "../wrapper-config.js";

/** 临时文件路径。 */
let majorPath: string;

afterEach(() => {
    if (majorPath !== undefined) {
        rmSync(majorPath, { force: true });
    }
});

describe("parseAppidFromMajor", () => {
    it("提取 QQAppId/ 后纯数字串", () => {
        majorPath = join(tmpdir(), `major-${Date.now()}-${Math.random()}.node`);
        writeFileSync(majorPath, Buffer.from("...QQAppId/537376818\x00..."));
        expect(parseAppidFromMajor(majorPath)).toBe("537376818");
    });

    it("多个标记取第一个纯数字", () => {
        majorPath = join(tmpdir(), `major-${Date.now()}-${Math.random()}.node`);
        writeFileSync(majorPath, Buffer.from("QQAppId/abc\x00QQAppId/12345\x00QQAppId/678\x00"));
        expect(parseAppidFromMajor(majorPath)).toBe("12345");
    });

    it("文件不存在返回 null", () => {
        expect(parseAppidFromMajor(join(tmpdir(), "no-such-major.node"))).toBeNull();
    });

    it("无 QQAppId/ 标记返回 null", () => {
        majorPath = join(tmpdir(), `major-${Date.now()}-${Math.random()}.node`);
        writeFileSync(majorPath, Buffer.from("no marker here"));
        expect(parseAppidFromMajor(majorPath)).toBeNull();
    });
});

describe("resolveAppidQua", () => {
    it("major 解析成功返回 appid 与 qua", () => {
        majorPath = join(tmpdir(), `major-${Date.now()}-${Math.random()}.node`);
        writeFileSync(majorPath, Buffer.from("QQAppId/537376818\x00"));
        const result = resolveAppidQua("9.9.33-51802", majorPath);
        expect(result.appid).toBe("537376818");
        // Linux/macOS 的 qua 用 `_` 连接版本与构建号（Windows 保留 `-`）
        const sep = process.platform === "win32" ? "-" : "_";
        expect(result.qua).toContain(`9.9.33${sep}51802`);
    });

    it("major 路径缺省 → 抛 KernelError（不再静默回退）", () => {
        expect(() => resolveAppidQua("9.9.31-49919", undefined)).toThrowError(KernelError);
        expect(() => resolveAppidQua("9.9.31-49919", undefined)).toThrowError(
            /无法从 major.node 解析 appid/,
        );
    });

    it("major 文件无 QQAppId/ 标记 → 抛 KernelError", () => {
        majorPath = join(tmpdir(), `major-${Date.now()}-${Math.random()}.node`);
        writeFileSync(majorPath, Buffer.from("no marker here"));
        expect(() => resolveAppidQua("9.9.33-51802", majorPath)).toThrowError(KernelError);
    });
});

describe("readMachineGuid", () => {
    it("getMachineGuid 返回字符串 → 原样返回", () => {
        const guid = "guid-1234-5678";
        const loginService = { getMachineGuid: () => guid };
        expect(readMachineGuid(loginService)).toBe(guid);
    });

    it("无 getMachineGuid 方法 → 空串", () => {
        expect(readMachineGuid({ initConfig: () => undefined })).toBe("");
        expect(readMachineGuid(undefined)).toBe("");
        expect(readMachineGuid(null)).toBe("");
    });

    it("getMachineGuid 抛错 / 返回非字符串 → 空串", () => {
        expect(
            readMachineGuid({
                getMachineGuid: () => {
                    throw new Error("boom");
                },
            }),
        ).toBe("");
        expect(readMachineGuid({ getMachineGuid: () => 123 })).toBe("");
    });
});

describe("buildSessionConfig guid", () => {
    const base = {
        appid: "537376818",
        fullVersion: "9.9.33-51802",
        selfUin: "3567141148",
        selfUid: "u_uid",
        accountPath: "C:/data/nt_qq/global",
        downloadPath: "C:/data/nt_qq/global/NapCat/temp",
    };

    it("machineGuid 传入 → deviceInfo.guid 填充", () => {
        const cfg = buildSessionConfig({ ...base, machineGuid: "guid-abc" });
        expect(cfg.deviceInfo.guid).toBe("guid-abc");
    });

    it("machineGuid 缺省 → deviceInfo.guid 空串", () => {
        const cfg = buildSessionConfig(base);
        expect(cfg.deviceInfo.guid).toBe("");
    });
});
