/**
 * wine-smoke.ts：Linux/wine 自建宿主加载冒烟（P2 Step 1 固化成果）。
 *
 * 用法（WSL2 内，从项目根；Node 24 直接跑 TS）：
 *   node tooling/wine/wine-smoke.ts [--ext4-dir <dir>]
 *
 * 流程：
 *   1. 确保 QQ 文件（P1 ensureQqFiles：本机无 QQ 则自动下载官方安装包 → 7z 解包 → 缓存）
 *   2. 确保 Windows 版 node.exe（P2 ensureWinNode：nodejs.org 官方 zip → 解压 → 缓存）
 *   3. wine 跑 win-node → dlopen wrapper.node（stub QQNT.dll 转发）→ 断言 98 exports
 *
 * ⚠️ 实测坑（2026-08-12 WSL2 验证）：wine 读 DrvFS（/mnt/c）会 "File not found"，
 *    QQ 文件必须放 **ext4 文件系统**（默认 `~/.napuketto/qq-files`）。本脚本把
 *    数据根放在 Linux 侧（缺省 `~/.napuketto`），不要指向 /mnt/c 下的目录。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
    defaultStubDir,
    ensureQqFiles,
    ensureWinNode,
    toWinePath,
} from "../../packages/loader/dist/index.mjs";

// ── 参数 ──
const argDir = process.argv.find((a) => a.startsWith("--ext4-dir="));
// 数据根缺省放 Linux 侧（ext4）：~/.napuketto（wine 读 /mnt/c 会失败，必须 ext4）
const dataRoot = argDir
    ? resolve(argDir.slice("--ext4-dir=".length))
    : join(homedir(), ".napuketto");
console.log(`[wine-smoke] 数据根（ext4）: ${dataRoot}`);

// 1. 确保 QQ 文件（P1）
console.log("[wine-smoke] 确保 QQ 文件…");
const qq = await ensureQqFiles({ dataRoot });
console.log(`[wine-smoke] QQ 文件 OK: version=${qq.version} wrapper=${qq.wrapperPath}`);

// 2. 确保 Windows 版 node.exe（P2）
console.log("[wine-smoke] 确保 Windows 版 node.exe…");
const winNode = await ensureWinNode({ dataRoot });
console.log(`[wine-smoke] win-node OK: ${winNode.exePath} (${winNode.version})`);

// 3. 确认 wine 存在
const wineBin = process.env["NAPUTO_WINE"] ?? "wine";
try {
    execFileSync(wineBin, ["--version"], { stdio: "pipe" });
} catch {
    console.log(`[wine-smoke] ❌ 未找到 wine（${wineBin}），请先安装：sudo apt install -y wine64`);
    process.exit(1);
}

// 4. 组装 dlopen 验证脚本（传给 wine 里的 win-node）
//    wine 视角：Z:\ = Linux 根；所有路径过 toWinePath
const stubHost = defaultStubDir(); // 本机 stub 目录（loader 包 native/build/stub-test-env）
if (!existsSync(join(stubHost, "QQNT.dll"))) {
    console.log(`[wine-smoke] ❌ stub QQNT.dll 未找到: ${stubHost}`);
    process.exit(1);
}
const wrapperDir = toWinePath(join(qq.wrapperPath, ".."));
const stubDir = toWinePath(stubHost);
console.log(`[wine-smoke] wrapperDir(Z:) = ${wrapperDir}`);
console.log(`[wine-smoke] stubDir(Z:) = ${stubDir}`);

const checkScript = `
const path = require('path');
const wrapperDir = ${JSON.stringify(wrapperDir)};
const stubDir = ${JSON.stringify(stubDir)};
process.env.PATH = stubDir + ';' + wrapperDir + ';' + process.env.PATH;
try {
  const m = { exports: {} };
  process.dlopen(m, path.join(wrapperDir, 'wrapper.node'));
  const keys = Object.keys(m.exports ?? {});
  console.log('dlopen-ok', keys.length, 'exports');
  console.log('sample:', keys.slice(0, 5).join(', '));
  if (!keys.includes('NodeIKernelLoginService')) { process.exit(2); }
  if (keys.length < 98) { process.exit(3); }
} catch (e) {
  console.log('dlopen-fail:', e.message);
  process.exit(1);
}
`;

console.log("[wine-smoke] wine 跑 win-node dlopen wrapper.node…");
const result = spawnSync(wineBin, [winNode.exePath, "-e", checkScript], {
    stdio: "inherit",
    env: { ...process.env },
});
if (result.status !== 0) {
    console.log(`[wine-smoke] ❌ 失败（exit=${result.status}）`);
    process.exit(result.status ?? 1);
}
console.log(
    "[wine-smoke] ✅ 通过：wine + win-node + stub → dlopen wrapper.node 成功（98 exports）",
);
