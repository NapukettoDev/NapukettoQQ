#!/usr/bin/env node
/**
 * release-npm.ts：npm 逐个发布 CLI（发布链最后一环）。
 *
 * 用法（Node 22.7+ 原生 type stripping，零构建直接跑）：
 *   node tooling/release/release-npm.ts            # 拓扑序逐个 npm publish --access public
 *   node tooling/release/release-npm.ts --dry-run  # 只跑 npm publish --dry-run（打包检查，不发布）
 *
 * 前置（由根 package.json 的 release 链保证）：
 *   1. pnpm -r build —— 各包 dist 已构建
 *
 * workspace:* 改写（2026-08-16 修复，本脚本自保证，不再依赖 changeset）：
 *   发布前把每个包 package.json 中 workspace:* 依赖改写为 caret 真实版本
 *   （按工作区当前版本），发布后恢复原样（git 保持 workspace:* 约定）。
 *   changeset version 正常跑时已改写 → 本步骤幂等空转；
 *   绕过 changeset 手动 bump 直发 → 本步骤兜底，杜绝 published 包泄漏
 *   workspace:*（yarn create / npm install 曾被迫交互选版本或直接失败）。
 *
 * 两种运行形态：
 *   - 本地（默认）：走本机 npm 登录态 + 2FA（`--otp=` / `NAPKETTO_NPM_OTP`）。
 *   - CI 可信发布（OIDC，2026-10-21 接入）：job 声明 `id-token: write` +
 *     `environment: release` 时，npm 用 Actions 的 id_token 换**包级**短时 token，
 *     不存在长期凭证，发布产物自动带 provenance。本脚本检测到
 *     `ACTIONS_ID_TOKEN_REQUEST_URL` 即进入 OIDC 模式：发布前先逐包预检信任
 *     配置（见 ./release-trust.ts），缺配置就整批不发（避免半批发上 npm）。
 *
 * 行为：
 *   - 发布前查询 registry：本地版本已存在（changeset 未 bump 的包）→ 跳过
 *   - 仅对需要发布的包做拓扑排序（被依赖者在前）并逐个 npm publish
 *   - OIDC 模式下发布前预检每个包的信任配置，404 = 没配 / claim 不符 / 已过期
 *   - 任一包失败 → 立即中断，退出码非 0（避免后续包依赖残缺上游）
 *   - npm 7+ git-checks：发布前工作区必须已提交（dirty 会被拒绝）
 *
 * 纯逻辑在 ./release-npm-core.ts（可单测），本文件只做参数解析 + 进程执行。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkspacePkg } from "./release-npm-core.ts";
import {
    discoverPackages,
    planPublish,
    rewriteWorkspaceProtocol,
    topoSort,
} from "./release-npm-core.ts";
import { fetchGithubIdToken, probeTrustConfigs } from "./release-trust.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const REGISTRY = process.env["NAPKETTO_REGISTRY"] ?? "https://registry.npmjs.org";

/** 命令行参数解析结果。 */
export interface ReleaseArgs {
    /** 只打包不发布（npm publish --dry-run）。 */
    dryRun: boolean;
    /** npm 2FA 一次性验证码（--otp= 或 NAPKETTO_NPM_OTP；缺省交给 npm 自行处理）。 */
    otp: string | undefined;
}

/** 解析命令行参数（--dry-run / --otp=）。 */
export function parseArgs(argv: readonly string[]): ReleaseArgs {
    let otp: string | undefined;
    for (const arg of argv) {
        if (arg.startsWith("--otp=")) {
            otp = arg.slice("--otp=".length);
        }
    }
    return {
        dryRun: argv.includes("--dry-run"),
        otp: otp ?? process.env["NAPKETTO_NPM_OTP"],
    };
}

/**
 * 查询单个 npm 包在 registry 的所有已发布版本。
 * 404（包从未发布）→ 空集；其他非 200 → 抛错（发布链中断）。
 */
export async function fetchPublishedVersions(pkgName: string): Promise<Set<string>> {
    const url = `${REGISTRY}/${pkgName.replace(/\//g, "%2F")}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) {
        return new Set();
    }
    if (!res.ok) {
        throw new Error(`registry 查询失败 ${pkgName}: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { versions?: Record<string, unknown> };
    return new Set(Object.keys(json["versions"] ?? {}));
}

/**
 * 是否处于 GitHub Actions 的 OIDC 可信发布模式。
 *
 * 判据与 npm CLI 一致：job 声明 `id-token: write` 后 Actions 才注入这两个
 * 变量。本地发布永远走登录态 + 2FA，不会命中此分支。
 */
export function isOidcTrustedPublishing(env: NodeJS.ProcessEnv = process.env): boolean {
    const requestUrl = env["ACTIONS_ID_TOKEN_REQUEST_URL"];
    const requestToken = env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
    return (
        typeof requestUrl === "string" &&
        requestUrl !== "" &&
        typeof requestToken === "string" &&
        requestToken !== ""
    );
}

/**
 * OIDC 信任配置预检：发布前逐包换一次 token。
 *
 * 换得到 = 该包当前有可用配置；404 = 没配 / claim 不符 / 已过期（npm 对三者
 * 同码回应，机制见 ./release-trust.ts）。命中就**一个包都不发**——否则半批
 * 已推上 npm、main 上的版本只发了一半，事后要靠补发擦屁股；而且下一轮又会
 * 撞上下一个缺配置的包，每轮只暴露一个缺口。
 *
 * 首发包（registry 无任何版本）不参与预检：信任配置挂在 npmjs.com 的包设置
 * 页上，包尚不存在就无从创建，换 token 必然 404。
 *
 * 返回 true 表示拦下本次发布。
 */
async function preflightTrustConfigs(
    ordered: readonly WorkspacePkg[],
    published: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<boolean> {
    const hasVersions = (pkg: WorkspacePkg): boolean => (published.get(pkg.name)?.size ?? 0) > 0;
    const existing = ordered.filter(hasVersions);
    const fresh = ordered.filter((pkg) => !hasVersions(pkg));
    if (fresh.length > 0) {
        console.log(
            `[release-npm] ℹ️ 首发包不参与预检（registry 无任何版本）：${fresh
                .map((pkg) => pkg.name)
                .join(", ")}`,
        );
    }
    if (existing.length === 0) {
        return false;
    }
    let idToken: string;
    try {
        idToken = await fetchGithubIdToken(REGISTRY);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(
            `[release-npm] ⚠️ 跳过 OIDC 信任配置预检（${message}）——缺配置的包仍会在 npm publish 处失败`,
        );
        return false;
    }
    console.log(`[release-npm] 🔐 预检 OIDC 信任配置（${existing.length} 个包）…`);
    const results = await probeTrustConfigs(
        idToken,
        REGISTRY,
        existing.map((pkg) => pkg.name),
    );
    const byName = new Map(results.map((result) => [result.name, result]));
    const missing: WorkspacePkg[] = [];
    for (const pkg of existing) {
        const result = byName.get(pkg.name);
        if (result?.status === "missing") {
            missing.push(pkg);
        } else if (result?.status === "error") {
            console.log(`[release-npm] ⚠️ 探测不确定 ${pkg.name}：${result.detail}（不据此拦截）`);
        }
    }
    if (missing.length === 0) {
        console.log(`[release-npm] ✅ OIDC 信任配置预检通过（${existing.length} 个包）`);
        return false;
    }
    console.log(
        `[release-npm] ❌ 以下 ${missing.length} 个包当前没有可用的 OIDC 信任配置，本次一个包都不发：`,
    );
    for (const pkg of missing) {
        console.log(`  ⛔ ${pkg.name}@${pkg.version}`);
    }
    console.log(
        "[release-npm] 💡 registry 一律回 404「package not found」，原因只有三种：没配过 / claim 与 release.yml 不符 / 配了但超过 2 天没完成首次发布而失效（失效记录不可编辑）。",
    );
    console.log("[release-npm] 💡 处置（本机 npm login，npm CLI ≥ 11.15）：");
    console.log(
        "[release-npm]    npm trust github <包名> --file release.yml --repo NapukettoDev/NapukettoQQ --environment release --allow-publish --yes",
    );
    console.log(
        "[release-npm]    已有失效记录先 npm trust revoke <包名> --id <id> 再重建；配完当天就发，别隔天。",
    );
    return true;
}

/** 在包目录执行 npm publish，返回退出码。 */
export function publishPkg(
    pkg: { name: string; dir: string },
    dryRun: boolean,
    otp: string | undefined,
): number {
    // --workspaces=false（2026-09-19）：根 package.json 声明 npm workspaces 字段
    // （5b96c48）后，npm 从包目录向上爬把主仓根认成 workspace root，读到根的
    // devEngines（强制 pnpm）→ EBADDEVENGINES 拒发。关掉 workspace 上下文即
    // 恢复 5b96c48 之前的行为（prefix 停在包目录自身，包内无 devEngines）。
    // --otp：账号开 2FA 时 publish 需要一次性验证码（EOTP），经参数/env 透传。
    const args = [
        "publish",
        "--access",
        "public",
        "--workspaces=false",
        ...(otp === undefined ? [] : ["--otp", otp]),
        ...(dryRun ? ["--dry-run"] : []),
    ];
    // Windows 上 npm 是 npm.cmd 批处理，CreateProcess 无法直接执行 .cmd（spawn
    // 报 ENOENT）——必须经 cmd.exe（ComSpec）显式执行。参数数组原样传递，不经
    // shell 展开，无注入面（规避 Node 对 shell:true 传参的 DEP0190 警告）。
    const isWin = process.platform === "win32";
    const cmd = isWin ? (process.env["ComSpec"] ?? "cmd.exe") : "npm";
    const cmdArgs = isWin ? ["/d", "/s", "/c", "npm", ...args] : args;
    const res = spawnSync(cmd, cmdArgs, {
        cwd: pkg.dir,
        stdio: "inherit",
    });
    if (res.error !== undefined) {
        // 进程启动失败（npm 不在 PATH 等）——不能只看 status，否则静默吞错
        process.stderr.write(`[release-npm] ⚠️ 无法启动 npm: ${res.error.message}\n`);
        return 1;
    }
    return res.status ?? 1;
}

/** 主流程：发现 → 查 registry 版本 → 过滤已发布 → 拓扑排序 → 逐个发布。 */
export async function main(argv: readonly string[]): Promise<number> {
    const { dryRun, otp } = parseArgs(argv);
    const pkgs = await discoverPackages(REPO_ROOT);
    if (pkgs.length === 0) {
        console.log("[release-npm] 未发现任何可发布包");
        return 0;
    }

    // 发布前查询 registry，只发布版本有变化的包（changeset 未 bump 的跳过）
    const published = new Map<string, Set<string>>();
    await Promise.all(
        pkgs.map(async (pkg) => {
            published.set(pkg.name, await fetchPublishedVersions(pkg.name));
        }),
    );
    const { toPublish, skipped } = planPublish(pkgs, published);

    if (skipped.length > 0) {
        console.log(`[release-npm] 跳过（版本已在 registry，${skipped.length} 个）:`);
        for (const item of skipped) {
            console.log(`  ⏭  ${item.pkg.name}@${item.pkg.version}（${item.reason}）`);
        }
    }
    if (toPublish.length === 0) {
        console.log("[release-npm] 无需发布，全部版本已在 registry");
        return 0;
    }

    const ordered = topoSort(toPublish);
    console.log(
        `[release-npm] 发布顺序（${ordered.length} 个包，${dryRun ? "dry-run" : "publish"}）:`,
    );
    for (const pkg of ordered) {
        console.log(`  ${pkg.name}@${pkg.version}`);
    }
    // OIDC 预检：逐包换一次 token，缺配置就整批不发（见 preflightTrustConfigs）
    if (!dryRun && isOidcTrustedPublishing()) {
        const blocked = await preflightTrustConfigs(ordered, published);
        if (blocked) {
            return 1;
        }
    }
    // workspace:* → caret 真实版本映射（按工作区当前版本，改写在 publish 前、恢复在 finally）
    const workspaceVersions = new Map(pkgs.map((pkg) => [pkg.name, pkg.version]));
    return await publishOrdered(ordered, workspaceVersions, dryRun, otp);
}

/**
 * 按拓扑序逐个发布（publish 前改写 workspace:* → 真实版本，finally 恢复原样）。
 * 任一包失败 → 返回非 0（后续包依赖残缺上游，立即中断）。
 */
async function publishOrdered(
    ordered: readonly WorkspacePkg[],
    workspaceVersions: ReadonlyMap<string, string>,
    dryRun: boolean,
    otp: string | undefined,
): Promise<number> {
    for (const pkg of ordered) {
        const manifestPath = join(pkg.dir, "package.json");
        const original = readFileSync(manifestPath, "utf8");
        const { text, changes } = rewriteWorkspaceProtocol(original, workspaceVersions);
        if (changes.length > 0) {
            writeFileSync(manifestPath, text, "utf8");
            console.log(
                `[release-npm] ✍️  ${pkg.name}: workspace:* → 真实版本 ${changes
                    .map((c) => `${c.dep}@${c.range}`)
                    .join(", ")}`,
            );
        }
        try {
            const code = publishPkg(pkg, dryRun, otp);
            if (code !== 0) {
                console.log(
                    `[release-npm] ❌ 发布失败: ${pkg.name}@${pkg.version}（退出码 ${code}），已中断`,
                );
                return code;
            }
            console.log(`[release-npm] ✅ 已发布: ${pkg.name}@${pkg.version}`);
        } finally {
            if (changes.length > 0) {
                writeFileSync(manifestPath, original, "utf8");
                console.log(`[release-npm] ↩ 已恢复 ${pkg.name}/package.json（workspace:*）`);
            }
        }
    }
    console.log(`[release-npm] 全部完成（${dryRun ? "dry-run" : "已发布"}）`);
    return 0;
}

// 直接执行（非被 import 测试）时运行
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2))
        .then((code) => {
            process.exitCode = code;
        })
        .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[release-npm] ❌ ${message}\n`);
            process.exitCode = 1;
        });
}
