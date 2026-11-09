/**
 * Linux 原生宿主 smoke（公开 CI 用；2026-11-10 新增）。
 *
 * 目的：在**不检私有 submodule** 的前提下，验证「用户装到的发布形态」能加载官方
 * Linux QQ 的 ELF `wrapper.node`。做法是消费 **已发布** 的 `@napuketto/loader`
 * tarball（自 0.6.x 起 `files` 含 `native/build/linux-x64`，tarball 自带 stub 与
 * `assets/7zip/7zz`），而不是从源码构建：
 *
 *   1. npm pack 取 tarball → 解包 → 断言 Linux stub `.so` 在包里（打包回归守卫）
 *   2. 读包内 `qq-releases.json` 的 linux/x64 条目 → 下载官方 deb（校验 sha256）
 *   3. 用包内 `7zz` 三层解包（ar → data.tar.xz → data.tar）→ 取 `wrapper.node`
 *   4. `LD_PRELOAD=<stub>:<libgnutls.so.30> node dlopen-check.cjs <wrapper>` →
 *      真 dlopen + 导出面断言（≥100 导出、含 NodeIQQNTWrapperEngine）
 *
 * 为什么不放进 PR 门禁：单次要下 ~190MB deb，且依赖 npm 上已发布的版本（发布滞后
 * 于 PR），放 nightly + 手动触发。
 *
 * 本地跑：`node tooling/linux-native-smoke/smoke.mjs [--loader-version 0.6.1]`
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DLOPEN_CHECK = join(__dirname, "dlopen-check.cjs");

/** 期望的最小导出面（wrapper 3.2.35 实测 104）。 */
const MIN_EXPORTS = 100;

/** 行拆分（npm / ldconfig 输出兼容）。 */
const LINE_SPLIT = /\r?\n/;

/** gnutls 候选（Ubuntu/Debian 多架构目录）。 */
const GNUTLS_CANDIDATES = [
    "/usr/lib/x86_64-linux-gnu/libgnutls.so.30",
    "/usr/lib64/libgnutls.so.30",
    "/usr/lib/libgnutls.so.30",
];

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

/** 输出最后一行的行文本（npm pack 产物名）。 */
function lastLine(text) {
    return (
        text
            .split(LINE_SPLIT)
            .map((l) => l.trim())
            .filter((l) => l !== "")
            .pop() ?? ""
    );
}

/** 下载 URL 归一化：`/QQNTV2/` 段必须小写，否则腾讯 CDN 返回 403。 */
function normalizeDownloadUrl(url) {
    return url.replace(/\/QQNTV2\//gi, "/qqntv2/");
}

/** 下载 + 流式算 sha256（避免 190MB 全进内存）。 */
async function download(url, dest) {
    log(`下载 ${url}`);
    const res = await fetch(url);
    if (!res.ok || res.body === null) {
        fail(`下载失败 HTTP ${String(res.status)} ${url}`);
        return "";
    }
    const hash = createHash("sha256");
    const out = createWriteStream(dest);
    const body = Readable.fromWeb(res.body);
    body.on("data", (chunk) => {
        hash.update(chunk);
    });
    await pipeline(body, out);
    return hash.digest("hex");
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

// ── 1. 取已发布 loader tarball（或本地 pack 的 tarball）并断言 Linux stub 在包内 ──
const tarballArg = arg("tarball");
let tgz = "";
if (tarballArg !== undefined && tarballArg !== "") {
    // 本地校验用：`npm pack` 在 packages/loader 产出的 tgz 直接喂进来
    tgz = resolve(tarballArg);
    if (!existsSync(tgz)) {
        fail(`--tarball 指向的文件不存在: ${tgz}`);
    }
    log(`本地 tarball ${tgz}`);
} else {
    const packRes = spawnSync(
        "npm",
        ["pack", `@napuketto/loader@${loaderVersion}`, "--pack-destination", work, "--silent"],
        { encoding: "utf8" },
    );
    if (packRes.status !== 0) {
        fail(`npm pack 失败: ${(packRes.stderr ?? "").trim()}`);
    }
    const tgzName = lastLine(packRes.stdout ?? "");
    tgz = join(work, tgzName);
    if (!existsSync(tgz)) {
        fail(`npm pack 未产出 tarball（stdout=${JSON.stringify(packRes.stdout)}）`);
    }
    log(`tarball ${tgzName}`);
}

const pkgDir = join(work, "pkg");
mkdirSync(pkgDir, { recursive: true });
run("tar", ["-xzf", tgz, "-C", pkgDir]);
const pkgRoot = join(pkgDir, "package");
const stub = join(pkgRoot, "native", "build", "linux-x64", "libnapuketto_stub.so");
if (!existsSync(stub)) {
    fail(
        `发布包缺少 Linux stub: ${stub}\n` +
            "→ packages/loader 的 files 必须含 native/build/linux-x64（见 PR #81）；" +
            `当前 loader 版本 ${loaderVersion} 可能早于该修复`,
    );
}
log(`Linux stub ${String(statSync(stub).size)} 字节`);

// ── 2. 读包内清单取 linux/x64 条目 ───────────────────────────────────────
const releases = JSON.parse(readFileSync(join(pkgRoot, "qq-releases.json"), "utf8"));
const linuxEntries = (releases.known ?? []).filter(
    (e) => (e.platform ?? "win32") === "linux" && (e.arch ?? "x64") === "x64",
);
const entry = linuxEntries[linuxEntries.length - 1];
if (entry === undefined) {
    fail("qq-releases.json 里没有 linux/x64 条目");
}
log(`官方 deb: ${entry.version} (core ${entry.coreVersion ?? "?"})`);

// ── 3. 下载 deb（sha256 校验；--keep-work 时复用已有文件）──────────────────
const deb = join(work, `qq-${entry.version}.deb`);
if (keepWork && existsSync(deb) && statSync(deb).size > 0) {
    log(`复用已有 deb ${String(statSync(deb).size)} 字节（跳过下载与 sha256 校验）`);
} else {
    const actualSha = await download(normalizeDownloadUrl(entry.url), deb);
    if (typeof entry.sha256 === "string" && entry.sha256 !== "" && entry.sha256 !== actualSha) {
        fail(`sha256 不匹配：期望 ${entry.sha256}，实际 ${actualSha}`);
    }
    log(`deb ${String(statSync(deb).size)} 字节，sha256 校验通过`);
}

// ── 4. 包内 7zz 三层解包 ────────────────────────────────────────────────
const sevenZip = join(pkgRoot, "assets", "7zip", "7zz");
if (!existsSync(sevenZip)) {
    fail(`发布包缺少 7zz: ${sevenZip}`);
}
chmodSync(sevenZip, 0o755);
const d0 = join(work, "d0");
const d1 = join(work, "d1");
const d2 = join(work, "d2");
const wrapper = join(d2, "opt", "QQ", "resources", "app", "wrapper.node");
if (keepWork && existsSync(wrapper)) {
    log("复用已解包的 wrapper.node（跳过三层解包）");
} else {
    run(sevenZip, ["x", deb, `-o${d0}`, "-y"]);
    // deb 的载荷名可能是 data.tar.xz（基线）或 data.tar（老格式），按存在性二选一
    const dataInside = [join(d0, "data.tar.xz"), join(d0, "data.tar")].find((p) => existsSync(p));
    if (dataInside === undefined) {
        fail(`deb 里找不到 data.tar(.xz)（${d0}）`);
    }
    run(sevenZip, ["x", dataInside, `-o${d1}`, "-y"]);
    const dataTar = join(d1, "data.tar");
    if (!existsSync(dataTar)) {
        fail(`data.tar.xz 解包后找不到 data.tar（${d1}）`);
    }
    run(sevenZip, ["x", dataTar, `-o${d2}`, "-y"]);
}

if (!existsSync(wrapper)) {
    fail(`解包后找不到 wrapper.node: ${wrapper}`);
}
const head = readFileSync(wrapper).subarray(0, 4);
if (!head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    fail(`wrapper.node 不是 ELF（${head.toString("hex")}）`);
}
log(`wrapper.node ${String(statSync(wrapper).size)} 字节（ELF）`);

// ── 5. 真 dlopen（stub + gnutls preload）─────────────────────────────────
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
log("smoke 通过：发布包 stub + 官方 deb + ELF wrapper + dlopen 导出面全部 OK");
