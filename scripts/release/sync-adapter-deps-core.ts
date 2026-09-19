/**
 * sync-adapter-deps-core.ts：koishi 适配器依赖同步核心逻辑（纯函数，可单测）。
 *
 * 职责：把 koishi-plugin-adapter 的 package.json 中 TRACKED_PACKAGES 各
 * @napuketto/* 包的依赖范围改写为 `~<registry latest>`，让插件发版时
 * 自动追踪主仓库已发布的最新 0.0.x 修复（用户安装/升级插件即拿到最新）。
 *
 * 时序（主仓库 release 链）：changeset version（workspace:* → caret）→
 * 本脚本（caret → ~latest）→ build → publish。changesets 写 caret 会锁死
 * 0.0.x 追踪，本脚本在 version 之后把范围刷成 tilde + 最新版。
 *
 * 纯函数不访问网络/文件系统——副作用由 CLI 层（sync-adapter-deps.ts）执行，
 * 本模块可被 vitest 直接单测。
 */

/**
 * 需要同步的 @napuketto/* 包（key = npm 包名）。
 * 2026-08-27：+ adapter / network（koishi 插件 OB11 动作桥子进程侧入口依赖，design.md §5.14）。
 * 2026-09-19：+ media（插件 voice-decode/actions 直接消费 decodeSilkToWav /
 *   encodePcmToSilk；0.0.32 钉 ~0.0.2 缺 decodeSilkToWav 导出，生产环境收方向
 *   语音解码不可用，且 0.0.3 起的 CJS 入口修复拿不到）。
 */
export const TRACKED_PACKAGES = [
    "@napuketto/kernel",
    "@napuketto/loader",
    "@napuketto/adapter",
    "@napuketto/network",
    "@napuketto/media",
] as const;

/** 单次变更项（planSync 产出）。 */
export interface DepChange {
    /** npm 包名。 */
    pkg: string;
    /** 当前依赖范围（缺省为 "(缺失)"）。 */
    from: string;
    /** 目标 tilde 范围。 */
    to: string;
}

/**
 * 比较两个 semver 版本号（纯数字段比较，忽略 pre-release 标签）。
 * 返回负数 = a<b，0 = a==b，正数 = a>b。
 *
 * @param a 版本号（如 "0.0.3"）
 * @param b 版本号（如 "0.0.6"）
 */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map((n) => Number.parseInt(n, 10));
    const pb = b.split(".").map((n) => Number.parseInt(n, 10));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] ?? 0;
        const nb = pb[i] ?? 0;
        if (na !== nb) {
            return na - nb;
        }
    }
    return 0;
}

/**
 * 解析版本范围，返回规范化的 tilde 范围（`~<版本>`）。
 *
 * 语义：**只向上追踪，绝不回退**——
 *  - 已是 `~<latest>` 且版本匹配 → null（无需改写）
 *  - 当前版本（去掉 ~/^/workspace: 前缀）**高于** registry latest → null
 *    （发布链场景：changeset 已把依赖升到本地新版本，registry 尚未发布，
 *    此时不回退——否则会把 `~0.0.4` 拉回 `~0.0.3`）
 *  - 其余 → 改写为 `~<latest>`
 *
 * @param current 当前依赖范围（如 "^0.0.3" / "~0.0.6" / "workspace:~"）
 * @param latest registry latest 版本（如 "0.0.6"）
 * @returns 需写入的 tilde 范围；无需改写则 null
 */
/** workspace: 前缀（版本范围归一化）。 */
const WORKSPACE_PREFIX_RE = /^workspace:/;
/** 版本前缀（~ ^ >= < v 等）。 */
const VERSION_PREFIX_RE = /^[~^>=<v\s]+/;
/** 语义化版本号开头。 */
const SEMVER_START_RE = /^\d+\.\d+\.\d+/;

export function tildeRange(current: string | undefined, latest: string): string | null {
    // 归一化比较：去掉 workspace: 前缀与空格
    const norm = (s: string) => s.replace(WORKSPACE_PREFIX_RE, "").trim();
    const cur = current === undefined ? "" : norm(current);
    const target = `~${latest}`;
    if (cur === target) {
        return null;
    }
    // 提取当前范围中的版本号（去掉 ~/^/>= 等前缀）
    const curVersion = cur.replace(VERSION_PREFIX_RE, "");
    // 版本号合法时，当前版本高于 registry latest → 不回退
    if (curVersion !== "" && curVersion !== "*" && SEMVER_START_RE.test(curVersion)) {
        if (compareVersions(curVersion, latest) > 0) {
            return null;
        }
    }
    return target;
}

/**
 * 计算一次同步的变更集（不改写任何文件）。
 *
 * @param deps 插件 package.json 的 dependencies 对象
 * @param latestVersions registry latest 版本映射（包名 → 版本）
 * @returns 变更集；无变更则空数组
 */
export function planSync(
    deps: Record<string, string>,
    latestVersions: Readonly<Record<string, string>>,
): DepChange[] {
    const changes: DepChange[] = [];
    for (const pkg of TRACKED_PACKAGES) {
        const latest = latestVersions[pkg];
        if (latest === undefined) {
            // 查询结果缺包 → 抛错（调用方保证完整性，见 fetchLatestVersions）
            throw new Error(`registry 未返回 ${pkg} 的 latest 版本`);
        }
        const current = deps[pkg];
        const to = tildeRange(current, latest);
        if (to !== null) {
            changes.push({ pkg, from: current ?? "(缺失)", to });
        }
    }
    return changes;
}

/**
 * 从 registry dist-tags 解析 latest 版本。
 *
 * @param distTags npm registry 响应的 "dist-tags" 对象
 * @returns latest 版本字符串
 */
export function latestFromDistTags(distTags: Readonly<Record<string, string>>): string {
    const latest = distTags["latest"];
    if (latest === undefined || latest === "") {
        throw new Error(`registry dist-tags 缺少 latest: ${JSON.stringify(distTags)}`);
    }
    return latest;
}
