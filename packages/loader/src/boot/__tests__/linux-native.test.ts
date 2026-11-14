/**
 * linux-native.ts：Linux 原生分支纯函数测试（不依赖真实 node/wrapper）。
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    defaultLinuxStubPath,
    gnutlsCandidates,
    LINUX_HOME_DIRNAME,
    linuxHomeEnv,
    linuxPreload,
    resolveLinuxHome,
} from "../linux-native.js";

describe("defaultLinuxStubPath", () => {
    it("指向包内 prebuilt/linux-x64，产物名为 libnapuketto_stub.so", () => {
        const p = defaultLinuxStubPath();
        expect(p).toContain(join("native", "prebuilt", "linux-x64"));
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

describe("resolveLinuxHome", () => {
    it("显式覆盖优先，且绝对化", () => {
        expect(
            resolveLinuxHome({
                dataRoot: "/data",
                cfgDir: "/data/10001",
                explicit: "/custom/home",
            }),
        ).toBe(resolve("/custom/home"));
    });

    it("显式空串视为未设置（回退数据根）", () => {
        expect(resolveLinuxHome({ dataRoot: "/data", cfgDir: "/data/10001", explicit: "" })).toBe(
            join(resolve("/data"), LINUX_HOME_DIRNAME),
        );
    });

    it("有数据根 → <数据根>/home", () => {
        expect(resolveLinuxHome({ dataRoot: "/data", cfgDir: "/data/10001" })).toBe(
            join(resolve("/data"), "home"),
        );
    });

    it("无数据根 → <账号目录>/home，绝不继承用户 $HOME", () => {
        expect(resolveLinuxHome({ cfgDir: "/data/10001" })).toBe(
            join(resolve("/data/10001"), "home"),
        );
        expect(resolveLinuxHome({ dataRoot: "", cfgDir: "/data/10001" })).toBe(
            join(resolve("/data/10001"), "home"),
        );
    });
});

describe("linuxHomeEnv", () => {
    it("HOME 与四个 XDG 变量全部收敛到受管目录（不含 XDG_RUNTIME_DIR）", () => {
        const home = resolve("/data/home");
        expect(linuxHomeEnv(home)).toEqual({
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_DATA_HOME: join(home, ".local", "share"),
            XDG_CACHE_HOME: join(home, ".cache"),
            XDG_STATE_HOME: join(home, ".local", "state"),
        });
    });

    it("不再携带宿主的 XDG_RUNTIME_DIR（会话级目录语义不同）", () => {
        expect(linuxHomeEnv("/data/home")).not.toHaveProperty("XDG_RUNTIME_DIR");
    });
});
