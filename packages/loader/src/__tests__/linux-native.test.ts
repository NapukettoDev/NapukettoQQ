/**
 * linux-native.ts：Linux 原生分支纯函数测试（不依赖真实 node/wrapper）。
 */
import { describe, expect, it, vi } from "vitest";
import {
    defaultLinuxStubPath,
    gnutlsCandidates,
    isLinuxNativeEnabled,
    linuxPreload,
    linuxStubArchDir,
} from "../linux-native.js";

describe("linuxStubArchDir / defaultLinuxStubPath", () => {
    it("按架构映射目录，产物名为 libnapuketto_stub.so", () => {
        expect(linuxStubArchDir("x64")).toBe("linux-x64");
        expect(linuxStubArchDir("arm64")).toBe("linux-arm64");
        const p = defaultLinuxStubPath();
        expect(p).toContain(`linux-${process.arch}`);
        expect(p.endsWith("libnapuketto_stub.so")).toBe(true);
    });
});

describe("gnutlsCandidates", () => {
    it("x64 / arm64 多架构路径", () => {
        expect(gnutlsCandidates("x64")[0]).toContain("x86_64-linux-gnu");
        expect(gnutlsCandidates("arm64")[0]).toContain("aarch64-linux-gnu");
    });
});

describe("linuxPreload", () => {
    it("stub 在前、gnutls 在后，冒号分隔", () => {
        expect(linuxPreload("/a/libnapuketto_stub.so", "/b/libgnutls.so.30")).toBe(
            "/a/libnapuketto_stub.so:/b/libgnutls.so.30",
        );
    });
});

describe("isLinuxNativeEnabled", () => {
    it("未设置 NAPUTO_LINUX_NATIVE 时恒为 false", () => {
        vi.stubEnv("NAPUTO_LINUX_NATIVE", "");
        expect(isLinuxNativeEnabled()).toBe(false);
    });

    it("非 linux 平台即使设置开关也不启用", () => {
        vi.stubEnv("NAPUTO_LINUX_NATIVE", "1");
        if (process.platform !== "linux") {
            expect(isLinuxNativeEnabled()).toBe(false);
        }
    });
});
