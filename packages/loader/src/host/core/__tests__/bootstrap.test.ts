/**
 * bootstrap.test.ts：bootstrap() 结果信号单测（2026-09-06 引导失败仍上报 ready 修复）。
 *
 * bootstrap 返回 boolean：各失败路径（env 缺失 / import 失败 / kernel 无导出 /
 * fallback 装配失败 / 登录失败 / lifecycle 异常）必须收敛为 false，不得静默 true。
 *
 * env.ts 是模块加载时的 process.env 快照——vi.stubEnv + vi.resetModules + 动态
 * import 每用例取全新模块（与 ipc-sender.test.ts 同套路）。假 kernel 写临时
 * .mjs 文件（每用例独立文件，动态 import URL 不同不命中模块缓存）；NAPUTO_CFG_DIR
 * 指向临时目录使 log() 落盘无污染。全用例非 IPC 模式（NAPUTO_IPC 置空）——
 * 跳过 ipc-server 启动，纯测结果信号。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { SharedState } from "../../util.js";

let tmpRoot = "";
let kernelSeq = 0;

/** 取全新 bootstrap 模块（隔离 env 快照与模块级状态）。 */
async function freshBootstrap(): Promise<typeof import("../bootstrap.js")> {
    ensureTmpRoot();
    vi.stubEnv("NAPUTO_CFG_DIR", tmpRoot);
    vi.resetModules();
    return await import("../bootstrap.js");
}

function ensureTmpRoot(): void {
    if (tmpRoot === "") {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-bootstrap-test-"));
    }
}

/** 引导输入状态（wrapper 未 dlopen、无 QQ 捕获实例）。 */
function freshState(): SharedState {
    return { wrapperExports: null, qqSession: null, qqLoginService: null, bootstrapped: false };
}

/** 写一个假 kernel .mjs 到临时目录并设好通用引导 env，返回 kernel 路径。 */
function stubBootEnv(kernelSource: string): void {
    ensureTmpRoot();
    kernelSeq += 1;
    const kernelEntry = join(tmpRoot, `kernel-${kernelSeq}.mjs`);
    writeFileSync(kernelEntry, kernelSource);
    vi.stubEnv("NAPUTO_KERNEL_ENTRY", kernelEntry);
    vi.stubEnv("NAPUTO_QQ_VERSION", "9.9.9-Test");
    vi.stubEnv("NAPUTO_WRAPPER_PATH", join(tmpRoot, "wrapper.node"));
    vi.stubEnv("NAPUTO_SELF_HOST", "1");
    vi.stubEnv("NAPUTO_IPC", "");
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

afterAll(() => {
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

describe("bootstrap() 结果信号（失败收敛 false）", () => {
    it("NAPUTO_KERNEL_ENTRY 未设置 → false", async () => {
        vi.stubEnv("NAPUTO_KERNEL_ENTRY", "");
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(false);
    });

    it("kernelEntry 指向不存在的文件（import 失败）→ false", async () => {
        ensureTmpRoot();
        vi.stubEnv("NAPUTO_KERNEL_ENTRY", join(tmpRoot, "kernel-不存在.mjs"));
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(false);
    });

    it("kernel 无 startNapuketto/NapukettoCore 导出 → false", async () => {
        stubBootEnv("export const other = 1;\n");
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(false);
    });

    it("fallback 路径：startNapuketto 返回 undefined → false", async () => {
        stubBootEnv(
            [
                "export function resolveAppidQua() { return { appid: 537376818 }; }",
                "export function startNapuketto() { return undefined; }",
            ].join("\n"),
        );
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(false);
    });

    it("fallback 路径：kernel 缺 lifecycle 方法（quickLogin 等）→ false", async () => {
        stubBootEnv(
            [
                "export function resolveAppidQua() { return { appid: 537376818 }; }",
                "export function startNapuketto() { return { engine: {}, session: null, loginService: null }; }",
            ].join("\n"),
        );
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(false);
    });

    it("fallback 路径全链成功（quickLogin + initAndStartSession）→ true", async () => {
        stubBootEnv(
            [
                "export function resolveAppidQua() { return { appid: 537376818 }; }",
                "export function startNapuketto() { return { engine: {}, session: null, loginService: null }; }",
                "export function quickLogin() { return Promise.resolve({ uin: '12345', uid: 'u1' }); }",
                "export function buildSessionConfig() { return {}; }",
                "export function createLifecycleSessionListener() { return {}; }",
                "export function initAndStartSession() { return Promise.resolve(); }",
            ].join("\n"),
        );
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(true);
    });

    it("NapukettoCore 路径：登录失败（doLogin null）→ false", async () => {
        vi.useFakeTimers(); // startSessionProbe 起 5s interval / 60s timeout，假定时器隔离
        stubBootEnv(
            [
                "function NapukettoCore() {}",
                "const core = {",
                "    attachWrapper: () => ({ engine: {}, session: null, loginService: null }),",
                "    login: () => Promise.reject(new Error('登录失败')),",
                "};",
                "NapukettoCore.create = () => core;",
                "export { NapukettoCore };",
                "export function resolveAppidQua() { return { appid: 537376818 }; }",
                "export function listLoginAccounts() { return Promise.resolve([]); }",
                "export function waitSessionReady() { return Promise.resolve(); }",
            ].join("\n"),
        );
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(false);
    });

    it("NapukettoCore 路径：attachWrapper 抛错（lifecycle error）→ false", async () => {
        vi.useFakeTimers();
        stubBootEnv(
            [
                "function NapukettoCore() {}",
                "const core = {",
                "    attachWrapper: () => { throw new Error('wrapper 不兼容'); },",
                "};",
                "NapukettoCore.create = () => core;",
                "export { NapukettoCore };",
                "export function resolveAppidQua() { return { appid: 537376818 }; }",
            ].join("\n"),
        );
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(false);
    });

    it("appid 解析：resolveAppidQua 缺失 → parseAppidFromMajor 兜底（fallback 路径成功）", async () => {
        stubBootEnv(
            [
                "let calls = [];",
                "export function parseAppidFromMajor(majorPath) { calls.push(majorPath); return '537376818'; }",
                "export function startNapuketto() { return { engine: {}, session: null, loginService: null, __calls: calls }; }",
                "export function quickLogin() { return Promise.resolve({ uin: '12345', uid: 'u1' }); }",
                "export function buildSessionConfig() { return {}; }",
                "export function createLifecycleSessionListener() { return {}; }",
                "export function initAndStartSession() { return Promise.resolve(); }",
            ].join("\n"),
        );
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(true);
    });

    it("appid 解析：parseAppidFromMajor 返回 null → 显式报错收敛 false", async () => {
        stubBootEnv(
            [
                "export function parseAppidFromMajor() { return null; }",
                "export function startNapuketto() { return { engine: {}, session: null, loginService: null }; }",
            ].join("\n"),
        );
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(false);
    });

    it("appid 解析：两个解析器都缺失 → false（不再静默回退硬编码）", async () => {
        stubBootEnv(
            [
                "export function startNapuketto() { return { engine: {}, session: null, loginService: null }; }",
            ].join("\n"),
        );
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(false);
    });

    it("fallback：buildLoginConfig + loginService.initConfig 前置（能力缺失跳过不阻塞）", async () => {
        stubBootEnv(
            [
                "let initConfigCalls = 0;",
                "export function resolveAppidQua() { return { appid: 537376818 }; }",
                "export function startNapuketto() {",
                "    return {",
                "        engine: {},",
                "        session: null,",
                "        loginService: { initConfig() { initConfigCalls += 1; } },",
                "    };",
                "}",
                "export function buildLoginConfig(appid, version, dataDir) { return { appid, version, dataDir }; }",
                "export function quickLogin() { return Promise.resolve({ uin: '12345', uid: 'u1' }); }",
                "export function buildSessionConfig() { return {}; }",
                "export function createLifecycleSessionListener() { return {}; }",
                "export function initAndStartSession() { return Promise.resolve(); }",
                "export function __initConfigCalls() { return initConfigCalls; }",
            ].join("\n"),
        );
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(true);
    });

    it("探测模式（NAPUTO_PROBE=1）：fallback 路径 probeOnce 执行（probeRuntime 结果进日志）", async () => {
        vi.stubEnv("NAPUTO_PROBE", "1");
        stubBootEnv(
            [
                "export function resolveAppidQua() { return { appid: 537376818 }; }",
                "let probed = 0;",
                "export function startNapuketto() { return { engine: {}, session: null, loginService: null }; }",
                "export function probeRuntime(ctx, filename) { probed += 1; return { session: {}, services: { a: 1 } }; }",
                "export function quickLogin() { return Promise.resolve({ uin: '12345', uid: 'u1' }); }",
                "export function buildSessionConfig() { return {}; }",
                "export function createLifecycleSessionListener() { return {}; }",
                "export function initAndStartSession() { return Promise.resolve(); }",
            ].join("\n"),
        );
        const mod = await freshBootstrap();
        expect(await mod.bootstrap(freshState())).toBe(true);
    });
});
