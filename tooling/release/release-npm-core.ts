/**
 * release-npm-core.ts：npm 发布链核心逻辑（纯函数，可单测）。
 *
 * 职责：发现 monorepo 工作区内可发布的包（packages/* 与 apps/*），
 * 按内部依赖拓扑排序——被依赖的包先发布、依赖者后发布，保证 npm
 * 逐个发包时解析到的是刚发布的新版本（npm 不像 pnpm -r 那样自动
 * 按拓扑序递归）。
 *
 * 只发布版本有变化的包：本地版本已存在于 registry → 跳过（changeset
 * 未 bump 的包版本不变，不应重复发布，否则 npm 报
 * "cannot publish over the previously published versions"）。
 *
 * 背景：pnpm -r publish 在部分环境存在上游 bug（用户侧无法修复），
 * 发布链的发布环节改用 `npm publish` 逐个执行。npm 不认识
 * pnpm-workspace.yaml 的 workspace:* 协议，因此必须先跑
 * `pnpm changeset version` 把依赖改写为真实版本号（caret），
 * 再由本模块排序逐个发布。
 *
 * 纯函数不访问网络；文件系统访问集中在 discoverPackages（接收根目录
 * 参数，便于单测用临时目录模拟工作区）。
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 工作区内一个可发布包。 */
export interface WorkspacePkg {
    /** npm 包名（package.json name）。 */
    name: string;
    /** 包目录绝对路径。 */
    dir: string;
    /** 当前版本号。 */
    version: string;
    /** dependencies 表（含 workspace:* 协议引用与 ~0.0.x 等范围）。 */
    dependencies: Record<string, string>;
}

/** 扫描的子目录（相对仓库根，各自展开一层通配）。 */
const WORKSPACE_GLOBS = ["packages", "apps"] as const;

/**
 * 展开根目录下一个 base（packages/apps）下的子目录列表。
 * base 不存在或不可读 → 空数组（工作区可能只有 packages）。
 */
async function expandGlobDirs(root: string, base: string): Promise<string[]> {
    const full = join(root, base);
    let entries: Dirent<string>[];
    try {
        entries = await readdir(full, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(full, entry.name));
}

/**
 * 读取单目录下的 package.json。
 * 无 package.json / 无 name / private 包 → null（不可发布）。
 */
async function loadPackage(dir: string): Promise<WorkspacePkg | null> {
    let raw: string;
    try {
        raw = await readFile(join(dir, "package.json"), "utf8");
    } catch {
        return null;
    }
    const pkg = JSON.parse(raw) as {
        name?: unknown;
        private?: unknown;
        version?: unknown;
        dependencies?: unknown;
    };
    if (typeof pkg.name !== "string" || pkg.name === "" || pkg.private === true) {
        return null;
    }
    return {
        name: pkg.name,
        dir,
        version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
        dependencies:
            pkg.dependencies === undefined ? {} : (pkg.dependencies as Record<string, string>),
    };
}

/** 发现工作区全部可发布包（原始顺序，未排序）。 */
export async function discoverPackages(root: string): Promise<WorkspacePkg[]> {
    const dirs = (
        await Promise.all(WORKSPACE_GLOBS.map((base) => expandGlobDirs(root, base)))
    ).flat();
    const pkgs = await Promise.all(dirs.map((dir) => loadPackage(dir)));
    return pkgs.filter((pkg): pkg is WorkspacePkg => pkg !== null);
}

/** 单个包跳过的原因（planPublish 产出）。 */
export interface SkippedPkg {
    /** 被跳过的包。 */
    pkg: WorkspacePkg;
    /** 跳过原因（如 "版本 0.0.1 已在 registry"）。 */
    reason: string;
}

/** planPublish 的发布计划。 */
export interface PublishPlan {
    /** 需要发布的包（保持入参顺序）。 */
    toPublish: WorkspacePkg[];
    /** 已存在于 registry、无需发布的包。 */
    skipped: SkippedPkg[];
}

/**
 * 计算需要发布的包：本地版本不在 registry 已发布版本集合中 → 发布；
 * 否则跳过。registry 首次发布（404 → 空集）→ 全部发布。
 *
 * @param pkgs 工作区全部可发布包
 * @param published 包名 → 该包在 registry 的所有已发布版本集合
 */
export function planPublish(
    pkgs: readonly WorkspacePkg[],
    published: ReadonlyMap<string, ReadonlySet<string>>,
): PublishPlan {
    const toPublish: WorkspacePkg[] = [];
    const skipped: SkippedPkg[] = [];
    for (const pkg of pkgs) {
        const versions = published.get(pkg.name);
        if (versions === undefined) {
            throw new Error(`缺少 ${pkg.name} 的 registry 版本信息（发布前必须查询）`);
        }
        if (versions.has(pkg.version)) {
            skipped.push({ pkg, reason: `版本 ${pkg.version} 已在 registry` });
        } else {
            toPublish.push(pkg);
        }
    }
    return { toPublish, skipped };
}

/**
 * 按内部依赖拓扑排序：被依赖者在前（kernel → media/network → adapter →
 * loader → cli → create-napukettoqq → koishi 适配器）。
 *
 * 依赖方向取自 dependencies 中出现的工作区内包名（koishi 适配器的
 * `~0.0.x` 范围同样命中）。存在环 → 抛错。
 */
export function topoSort(pkgs: readonly WorkspacePkg[]): WorkspacePkg[] {
    const byName = new Map(pkgs.map((pkg) => [pkg.name, pkg]));
    // 入度 = 依赖的内部包数量
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const pkg of pkgs) {
        const internalDeps = Object.keys(pkg.dependencies).filter((name) => byName.has(name));
        inDegree.set(pkg.name, internalDeps.length);
        for (const dep of internalDeps) {
            const list = dependents.get(dep) ?? [];
            list.push(pkg.name);
            dependents.set(dep, list);
        }
    }
    const queue = pkgs.filter((pkg) => (inDegree.get(pkg.name) ?? 0) === 0).map((pkg) => pkg.name);
    const ordered: string[] = [];
    while (queue.length > 0) {
        const name = queue.shift();
        if (name === undefined) {
            break;
        }
        ordered.push(name);
        for (const dependent of dependents.get(name) ?? []) {
            const next = (inDegree.get(dependent) ?? 0) - 1;
            inDegree.set(dependent, next);
            if (next === 0) {
                queue.push(dependent);
            }
        }
    }
    if (ordered.length !== pkgs.length) {
        const cyclic = pkgs.map((pkg) => pkg.name).filter((name) => !ordered.includes(name));
        throw new Error(`内部依赖存在环，无法确定发布顺序: ${cyclic.join(", ")}`);
    }
    return ordered.map((name) => byName.get(name) as WorkspacePkg);
}

/** package.json 中可含 workspace:* 依赖的字段（发布时必须全部改写）。 */
const WORKSPACE_DEP_FIELDS = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
] as const;

/** 单个依赖改写记录。 */
export interface WorkspaceRewrite {
    /** 所在字段（dependencies 等）。 */
    field: string;
    /** 依赖包名。 */
    dep: string;
    /** 改写后的版本范围（caret）。 */
    range: string;
}

/**
 * 把 package.json 文本中所有 `workspace:*` 依赖改写为 caret 真实版本
 * （npm 不认 workspace 协议，发布前必须改写；`changeset version` 正常跑时
 * 已改写，此处幂等兜底——2026-08-16 修复：曾绕过 changeset 直发，published
 * 包泄漏 workspace:*，yarn create / npm install 被迫交互选版本或直接失败）。
 *
 * 返回改写后的 JSON 文本与改写记录；无 workspace:* 时原样返回（不改写不重排）。
 * 工作区内找不到对应包版本 → 抛错（无法生成真实范围，发布链中断）。
 */
export function rewriteWorkspaceProtocol(
    raw: string,
    workspaceVersions: ReadonlyMap<string, string>,
): { text: string; changes: WorkspaceRewrite[] } {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const changes: WorkspaceRewrite[] = [];
    for (const field of WORKSPACE_DEP_FIELDS) {
        const deps = pkg[field];
        if (typeof deps !== "object" || deps === null) {
            continue;
        }
        for (const [dep, range] of Object.entries(deps as Record<string, unknown>)) {
            if (range !== "workspace:*") {
                continue;
            }
            const version = workspaceVersions.get(dep);
            if (version === undefined) {
                throw new Error(
                    `依赖 ${dep} 声明为 workspace:*，但工作区内找不到该包版本（无法改写为真实版本号）`,
                );
            }
            (deps as Record<string, string>)[dep] = `^${version}`;
            changes.push({ field, dep, range: `^${version}` });
        }
    }
    const text = changes.length > 0 ? `${JSON.stringify(pkg, null, 4)}\n` : raw;
    return { text, changes };
}
