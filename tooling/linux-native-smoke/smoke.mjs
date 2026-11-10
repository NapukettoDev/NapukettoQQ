/**
 * Linux 原生宿主 smoke（公开 CI 用；2026-11-10 新增，2026-11-10 改为走真 loader 管线）。
 *
 * 目的：在**不检私有 submodule** 的前提下，验证「用户装到的发布形态」能加载官方
 * Linux QQ 的 ELF `wrapper.node`。做法是**安装已发布的 `@napuketto/loader`**（而不是
 * 从源码构建），然后直接调它的 `resolveQqFiles`——也就是用户真正走的那条链路：
 *
 *   1. `npm install @napuketto/loader@<版本>`（真实安装形态，带 zod 依赖）
 *   2. 断言包内 `native/build/linux-x64/libnapuketto_stub.so` 存在（打包回归守卫）
 *   3. `resolveQqFiles({ dataRoot, autoDownload: true })`：
 *      读清单 → 下载官方 deb（loader 内部校验 sha256）→ 包内 7zz 三层解包 →
 *      `extractLinuxWrapperFiles` 合成缓存布局 → 返回 `wrapperPath`/`version`
 *   4. `LD_PRELOAD=<stub>:<libgnutls.so.30> node dlopen-check.cjs <wrapper>` →
 *      真 `process.dlopen` + 导出面断言（≥100 导出、含 NodeIQQNTWrapperEngine）
 *
 * 为什么不放进 PR 门禁：单次要下 ~190MB deb，且依赖 npm 上已发布的版本（发布滞后
 * 于 PR），放 nightly + 手动触发。
 *
 * 本地跑：`node tooling/linux-native-smoke/smoke.mjs [--loader-version 0.6.1]` 或
 * `--tarball <本地 npm pack 产物>`（校验待发布的包）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DLOPEN_CHECK = join(__dirname, "dlopen-check.cjs");

/** 期望的最小导出面（wrapper 3.2.35 实测 104）。 */
const MIN_EXPORTS = 100;

/** gnutls 候选（Ubuntu/Debian 多架构目录）。 */
const GNUTLS_CANDIDATES = [
    "/usr/lib/x86_64-linux-gnu/libgnutls.so.30",
    "/usr/lib64/libgnutls.so.30",
    "/usr/lib/libgnutls.so.30",
];

/** ELF 魔数。 */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** `--key value` 解析（缺省 undefined）。 */
function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 打日志（CI 里一眼看出进度）。 */
function log(message) {
    process.stdout.write(`[smoke] ${message}\n`);
}

/** 失败退出（带可读原因）。 */
function fail(message) {
    process.stderr.write(`[smoke] ERROR ${message}\n`);
    process.exit(1);
}

/** 跑子进程，非零即失败（stdio 继承，日志直接进 CI）。 */
function run(cmd, args, options = {}) {
    log(`$ ${cmd} ${args.join(" ")}`);
    const res = spawnSync(cmd, args, { stdio: "inherit", ...options });
    if (res.error !== undefined) {
        fail(`${cmd} 执行失败: ${res.error.message}`);
    }
    if (res.status !== 0) {
        fail(`${cmd} 退出码 ${String(res.status)}`);
    }
}

/** 解析系统 libgnutls（Ubuntu/Debian/Fedora 常见多架构路径）。 */
function resolveGnutls() {
    return GNUTLS_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

// ── 0. 工作目录 ───────────────────────────────────────────────────────────
const loaderVersion = arg("loader-version") ?? process.env["LOADER_VERSION"] ?? "latest";
const work = resolve(arg("work-dir") ?? join(tmpdir(), "napuketto-linux-smoke"));
const keepWork = arg("keep-work") !== undefined;
if (!keepWork) {
    rmSync(work, { recursive: true, force: true });
}
mkdirSync(work, { recursive: true });
log(`工作目录 ${work}；loader=${loaderVersion}${keepWork ? "（复用已有产物）" : ""}`);

// ── 1. 安装已发布 loader（真实安装形态：dist + native + assets + qq-releases.json）──
const appDir = join(work, "app");
const tarballArg = arg("tarball");
const spec =
    tarballArg !== undefined && tarballArg !== ""
        ? resolve(tarballArg)
        : `@napuketto/loader@${loaderVersion}`;
if (tarballArg !== undefined && tarballArg !== "" && !existsSync(spec)) {
    fail(`--tarball 指向的文件不存在: ${spec}`);
}
const installed = join(appDir, "node_modules", "@napuketto", "loader");
if (keepWork && existsSync(join(installed, "dist", "index.mjs"))) {
    log("复用已安装的 loader（跳过 npm install）");
} else {
    run("npm", [
        "install",
        "--prefix",
        appDir,
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        spec,
    ]);
}
const entry = join(installed, "dist", "index.mjs");
if (!existsSync(entry)) {
    fail(`安装后找不到 loader 入口: ${entry}（spec=${spec}）`);
}

// ── 2. 打包回归守卫：Linux stub 必须在包里 ─────────────────────────────
const stub = join(installed, "native", "build", "linux-x64", "libnapuketto_stub.so");
if (!existsSync(stub)) {
    fail(
        `发布包缺少 Linux stub: ${stub}\n` +
            "→ packages/loader 的 files 必须含 native/build/linux-x64（见 PR #81）；" +
            `当前 loader 版本 ${loaderVersion} 可能早于该修复`,
    );
}
log(`Linux stub ${String(statSync(stub).size)} 字节`);

// ── 3. 走真 loader 管线拿 wrapper.node（下载 + sha256 + 7zz 解包 + 缓存布局）──
const loader = await import(pathToFileURL(entry).href);
if (typeof loader.resolveQqFiles !== "function") {
    fail("loader 没有导出 resolveQqFiles（版本过旧？）");
}
const dataRoot = join(work, "data");
const info = await loader.resolveQqFiles({
    dataRoot,
    autoDownload: true,
    onStage: (message) => log(`loader: ${message}`),
});
const wrapper = info.wrapperPath;
if (!existsSync(wrapper)) {
    fail(`resolveQqFiles 返回的 wrapperPath 不存在: ${wrapper}`);
}
const head = readFileSync(wrapper).subarray(0, 4);
if (!head.equals(ELF_MAGIC)) {
    fail(`wrapper.node 不是 ELF（${head.toString("hex")}）`);
}
log(
    `loader 解析结果: version=${info.version} source=${info.source} ` +
        `wrapper=${String(statSync(wrapper).size)} 字节（ELF）`,
);

// ── 4. 真 dlopen（stub + gnutls preload）──────────────────────────────────
const gnutls = resolveGnutls();
if (gnutls === null) {
    fail("找不到系统 libgnutls.so.30（Ubuntu 24.04 装 libgnutls30t64）");
}
log(`gnutls ${gnutls}`);
const child = spawnSync(process.execPath, [DLOPEN_CHECK, wrapper, String(MIN_EXPORTS)], {
    stdio: "inherit",
    env: { ...process.env, LD_PRELOAD: `${stub}:${gnutls}` },
});
if (child.status !== 0) {
    fail(`dlopen 检查失败（退出码 ${String(child.status)}）`);
}
log("smoke 通过：发布包 stub + loader deb 管线 + ELF wrapper + dlopen 导出面全部 OK");
