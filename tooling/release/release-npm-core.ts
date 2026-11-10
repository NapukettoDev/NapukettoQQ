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

/** package.json 中可含 `workspace:*` / `catalog:` 依赖的字段（发布时必须全部改写）。 */
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
    /** 改写后的版本范围（caret / catalog 原始范围）。 */
    range: string;
}

/** YAML 行尾空白。 */
const TRAILING_SPACE_RE = /\s+$/;
/** CRLF 的 CR（Windows 上编辑过的 yaml 必须能吃）。 */
const CR_RE = /\r$/;
/** 顶格行 = YAML 顶层键。 */
const TOP_LEVEL_KEY_RE = /^\S/;
/** 发布包里不允许出现的协议前缀。 */
const PROTOCOL_PREFIX_RE = /^(?:workspace|catalog):/;

/** 去掉 YAML 行尾的 ` #…` 注释（catalog 条目没有引号内的 ` #`，无需完整词法）。 */
function stripYamlComment(line: string): string {
    const index = line.indexOf(" #");
    const stripped = index === -1 ? line : line.slice(0, index);
    return stripped.replace(TRAILING_SPACE_RE, "");
}

/** 去掉成对的首尾引号（`"@hono/node-server"` → `@hono/node-server`）。 */
function unquoteYamlScalar(value: string): string {
    const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
    return quoted ? value.slice(1, -1) : value;
}

/**
 * 解析 pnpm-workspace.yaml 默认 `catalog:` 段（包名 → 版本范围）。
 *
 * 发布链只需要这一段，故不引入 YAML 依赖：逐行扫，顶格的 `catalog:` 进入段内，
 * 下一个顶格键结束；段内 `包名: 版本`（键值均可带引号）逐行收集，跳过空行与
 * 整行注释。命名 catalog（`catalog:<名字>` / `catalogs:` 段）不解析——遇到这类
 * 依赖时由 rewriteDependencyProtocols 报可读错误，而不是静默发错包。
 */
export function parseCatalogSpecs(yaml: string): Map<string, string> {
    const specs = new Map<string, string>();
    let inCatalog = false;
    for (const rawLine of yaml.split("\n")) {
        const line = rawLine.replace(CR_RE, "");
        if (TOP_LEVEL_KEY_RE.test(line)) {
            // 顶格行 = 顶层键：`catalog:` 开始段，其它键结束段
            inCatalog = line.trim() === "catalog:";
            continue;
        }
        if (!inCatalog) {
            continue;
        }
        const body = stripYamlComment(line).trim();
        if (body === "" || body.startsWith("#")) {
            continue;
        }
        const sep = body.indexOf(":");
        if (sep <= 0) {
            continue;
        }
        const key = unquoteYamlScalar(body.slice(0, sep).trim());
        const value = unquoteYamlScalar(body.slice(sep + 1).trim());
        if (key !== "" && value !== "") {
            specs.set(key, value);
        }
    }
    return specs;
}

/** 单个依赖的协议改写结果。 */
interface DependencyRewrite {
    /** 改写来源：workspace 协议 / 默认 catalog。 */
    kind: "workspace" | "catalog";
    /** 改写后的真实版本范围。 */
    next: string;
}

/**
 * 解析单个依赖声明，返回改写结果（`null` = 不是协议依赖，原样保留）。
 *
 * 无法解析或不支持的协议 → 抛可读错误（发布链立即中断，绝不发用户装不上的包）。
 */
function resolveDependencyProtocol(
    dep: string,
    range: unknown,
    workspaceVersions: ReadonlyMap<string, string>,
    catalog: ReadonlyMap<string, string>,
): DependencyRewrite | null {
    if (typeof range !== "string") {
        return null;
    }
    if (range === "workspace:*") {
        const version = workspaceVersions.get(dep);
        if (version === undefined) {
            throw new Error(
                `依赖 ${dep} 声明为 workspace:*，但工作区内找不到该包版本（无法改写为真实版本号）`,
            );
        }
        return { kind: "workspace", next: `^${version}` };
    }
    if (range.startsWith("workspace:")) {
        throw new Error(
            `依赖 ${dep} 的 workspace 协议 "${range}" 不受支持（发布链只改写 workspace:*）`,
        );
    }
    if (range === "catalog:") {
        const spec = catalog.get(dep);
        if (spec === undefined) {
            throw new Error(
                `依赖 ${dep} 声明为 catalog:，但 pnpm-workspace.yaml 的 catalog 段没有该条目（无法解析为真实版本范围）`,
            );
        }
        return { kind: "catalog", next: spec };
    }
    if (range.startsWith("catalog:")) {
        throw new Error(
            `依赖 ${dep} 使用命名 catalog "${range}"，发布链不支持（只用默认 catalog 段）`,
        );
    }
    return null;
}

/**
 * 把 package.json 文本中的协议依赖改写为真实版本范围（npm 既不认
 * `workspace:*` 也不认 `catalog:`，发布前必须改写）：
 *
 * - `workspace:*` → `^<工作区当前版本>`（工作区里查不到该包 → 抛错）
 * - `catalog:` → pnpm-workspace.yaml 默认 `catalog:` 段的同名条目
 *
 * `catalog:` 必须在这里兜底：`changeset version` 只负责 `workspace:*`，从不碰
 * catalog。2026-11-03 引入 catalog 后，发布的 `@napuketto/network` / `adapter` /
 * `loader` 都把 `catalog:` 原样发上 npm，用户 `npm install` 直接
 * `EUNSUPPORTEDPROTOCOL`（2026-11-10 nightly smoke 抓到；本函数是那次的修复）。
 *
 * 返回改写后的 JSON 文本与两类改写记录；无需改写时原样返回（不改写不重排）。
 */
export function rewriteDependencyProtocols(
    raw: string,
    workspaceVersions: ReadonlyMap<string, string>,
    catalog: ReadonlyMap<string, string> = new Map(),
): { text: string; changes: WorkspaceRewrite[]; catalogChanges: WorkspaceRewrite[] } {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const changes: WorkspaceRewrite[] = [];
    const catalogChanges: WorkspaceRewrite[] = [];
    for (const field of WORKSPACE_DEP_FIELDS) {
        const deps = pkg[field];
        if (typeof deps !== "object" || deps === null) {
            continue;
        }
        const table = deps as Record<string, string>;
        for (const dep of Object.keys(table)) {
            const rewrite = resolveDependencyProtocol(dep, table[dep], workspaceVersions, catalog);
            if (rewrite === null) {
                continue;
            }
            table[dep] = rewrite.next;
            const record = { field, dep, range: rewrite.next };
            (rewrite.kind === "workspace" ? changes : catalogChanges).push(record);
        }
    }
    const text =
        changes.length + catalogChanges.length > 0 ? `${JSON.stringify(pkg, null, 4)}\n` : raw;
    return { text, changes, catalogChanges };
}

/**
 * 发布前断言：四个依赖字段里不得残留 `workspace:` / `catalog:` 协议。
 *
 * 这是改写之后的最后一道闸——任何协议泄漏都会让用户侧 `npm install` 直接
 * `EUNSUPPORTEDPROTOCOL`，而发布链此前完全没有察觉（0.6.x–0.7.x 事故）。
 */
export function assertNoProtocolLeftovers(raw: string): void {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const leftovers: string[] = [];
    for (const field of WORKSPACE_DEP_FIELDS) {
        const deps = pkg[field];
        if (typeof deps !== "object" || deps === null) {
            continue;
        }
        for (const [dep, range] of Object.entries(deps as Record<string, unknown>)) {
            if (typeof range === "string" && PROTOCOL_PREFIX_RE.test(range)) {
                leftovers.push(`${field}.${dep}=${range}`);
            }
        }
    }
    if (leftovers.length > 0) {
        throw new Error(`发布前仍有未改写的协议依赖：${leftovers.join(", ")}`);
    }
}
