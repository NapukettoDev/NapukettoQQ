/**
 * wine-login-smoke.ts：Linux/wine 完整链路登录冒烟（P2 Step 2）。
 *
 * 用法（WSL2 内，从项目根；Node 24 直接跑 TS）：
 *   node tooling/wine/wine-login-smoke.ts [--ext4-dir <dir>] [--uin <QQ号>]
 *
 * 流程（复用自建宿主全链路，与 Windows 完全一致，仅换宿主为 wine + win-node）：
 *   1. 确保 QQ 文件（P1 ensureQqFiles）
 *   2. 确保 Windows 版 node.exe（P2 ensureWinNode）
 *   3. wine 跑 win-node → self-host.cjs（NAPUTO_* 环境变量注入，路径过 toWinePath）
 *      └─ dlopen wrapper.node（stub 转发）→ O3MiscService 激活 → bootstrap
 *      └─ 登录（快速登录指定 uin / 未指定则交互）→ session READY → 协议装配
 *
 * ⚠️ 与 Step 1 相同的坑：数据根必须放 ext4（wine 读 /mnt/c 会 File not found）。
 * ⚠️ 登录是长驻进程（协议服务在事件循环），脚本在 session READY 后观察 30s 退出。
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    defaultStubDir,
    ensureQqFiles,
    ensureWinNode,
    toWinePath,
} from "../../packages/loader/dist/index.mjs";

// ── 参数 ──
const argDir = process.argv.find((a) => a.startsWith("--ext4-dir="));
const argUin = process.argv.find((a) => a.startsWith("--uin="));
const dataRoot = argDir
    ? resolve(argDir.slice("--ext4-dir=".length))
    : join(homedir(), ".napuketto");
const uin = argUin ? argUin.slice("--uin=".length) : undefined;
console.log(`[wine-login] 数据根（ext4）: ${dataRoot}`);
if (uin !== undefined) {
    console.log(`[wine-login] 快速登录 uin: ${uin}`);
}

// 1. 确保 QQ 文件（P1）
console.log("[wine-login] 确保 QQ 文件…");
const qq = await ensureQqFiles({ dataRoot });
console.log(`[wine-login] QQ 文件 OK: version=${qq.version}`);

// 2. 确保 Windows 版 node.exe（P2）
console.log("[wine-login] 确保 Windows 版 node.exe…");
const winNode = await ensureWinNode({ dataRoot });
console.log(`[wine-login] win-node OK: ${winNode.exePath} (${winNode.version})`);

// 3. stub 校验
const stubHost = defaultStubDir();
if (!existsSync(join(stubHost, "QQNT.dll"))) {
    console.log(`[wine-login] ❌ stub QQNT.dll 未找到: ${stubHost}`);
    process.exit(1);
}
console.log(`[wine-login] stub OK: ${stubHost}`);

// 4. 装配环境变量（与 launcher.buildLaunchEnv 同构；wine 场景路径过 toWinePath）
const wrapperDir = join(qq.wrapperPath, "..");
const cfgDir = join(dataRoot, uin ?? "default");
const env: Record<string, string | undefined> = {
    ...process.env,
    NAPUTO_QQ_PATH: toWinePath(join(dataRoot, "QQ.exe")), // 语义占位
    NAPUTO_QQ_VERSION: qq.version,
    NAPUTO_WRAPPER_PATH: toWinePath(qq.wrapperPath),
    NAPUTO_CFG_DIR: toWinePath(cfgDir),
    NAPUTO_SELF_HOST: "1",
    NAPUTO_STUB_DIR: toWinePath(stubHost),
    // PATH：stub 目录 + wrapper.node 目录前置（wine 按 Z:\ 解析）
    PATH: [toWinePath(stubHost), toWinePath(wrapperDir), process.env["PATH"] ?? ""].join(";"),
};
if (uin !== undefined) {
    env["NAPUTO_QUICK_UIN"] = uin;
}

// 5. 定位并复制运行时到 ext4（wine 读不了 /mnt/c DrvFS！）
//    ⚠️ 2026-08-12 实测：wine 读 /mnt/c 会失败（同 wrapper.node 的坑）。
//    self-host.cjs 是单文件 CJS bundle，kernel dist 是单文件 ESM bundle——
//    把这两个复制到 ext4 运行时目录即可（wine 内路径过 toWinePath）。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "../..");
const srcSelfHost = join(projectRoot, "packages", "loader", "dist", "host", "self-host.cjs");
const srcKernel = join(projectRoot, "packages", "kernel", "dist", "index.mjs");
if (!existsSync(srcSelfHost)) {
    console.log(`[wine-login] ❌ self-host.cjs 未找到: ${srcSelfHost}`);
    process.exit(1);
}
if (!existsSync(srcKernel)) {
    console.log(`[wine-login] ❌ kernel dist 未找到: ${srcKernel}`);
    process.exit(1);
}
const runtimeDir = join(dataRoot, "runtime", "smoke");
mkdirSync(runtimeDir, { recursive: true });
const selfHostPath = join(runtimeDir, "self-host.cjs");
const kernelPath = join(runtimeDir, "kernel.mjs");
copyFileSync(srcSelfHost, selfHostPath);
copyFileSync(srcKernel, kernelPath);
console.log(`[wine-login] 运行时已复制到 ext4: ${runtimeDir}`);
console.log(`[wine-login] wine 跑 self-host（路径 Z:\\ 视角）…`);

// 6. kernel entry 环境变量（指向 ext4 的 kernel.mjs，wine 视角 Z:\）
env["NAPUTO_KERNEL_ENTRY"] = toWinePath(kernelPath);

// 7. spawn wine + win-node + self-host.cjs（登录长驻，观察后退出）
const wineBin = process.env["NAPUTO_WINE"] ?? "wine";
const child = spawn(wineBin, [winNode.exePath, toWinePath(selfHostPath)], {
    cwd: dataRoot,
    env,
    stdio: ["inherit", "pipe", "pipe"],
});
let sawReady = false;
const timeout = setTimeout(() => {
    console.log(`[wine-login] ⏱️ ${sawReady ? "已见 ready，超时观察结束" : "90s 未 ready"}，退出`);
    child.kill("SIGKILL");
}, 90_000);

function onLine(tag: string, line: string) {
    console.log(`[wine-login] ${tag}: ${line}`);
    if (line.includes("bootstrap 完成") || (line.includes("session") && line.includes("READY"))) {
        sawReady = true;
    }
}
child.stdout?.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
        if (line.trim() !== "") onLine("stdout", line.trim());
    }
});
child.stderr?.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
        if (line.trim() !== "") onLine("stderr", line.trim());
    }
});
child.on("error", (e) => {
    console.log(`[wine-login] ⚠️ spawn 失败: ${e.message}`);
});
child.on("exit", (code, signal) => {
    clearTimeout(timeout);
    console.log(`[wine-login] 子进程退出 code=${code} signal=${signal ?? ""}`);
    if (sawReady) {
        console.log("[wine-login] ✅ 通过：session READY（完整链路 wine 下跑通）");
        process.exit(0);
    }
    console.log(`[wine-login] ❌ 未达到 ready 就退出（code=${code}）`);
    process.exit(code ?? 1);
});
