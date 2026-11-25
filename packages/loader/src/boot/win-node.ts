/**
 * win-node.ts：Windows 版 node.exe 获取与宿主 node 解析（仅 win32，非 node 宿主场景）。
 * 非 node 宿主（Bun 等，execPath=bun.exe）进程内没有 stub `QQNT.dll`，宿主符号无人转发，LoadLibrary 报 1114，须用真 node.exe。
 * 运行时下载到 <数据根>/runtime/win-node/，可被 NAPUKETTO_WIN_NODE_PATH 覆盖；Linux 不适用（直接跑系统 node）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { copyFile, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { downloadFile } from "../artifacts/download.js";
import { extractInstaller } from "../artifacts/extract.js";
import { resolveDataRoot } from "../shared/data-root.js";
import { LINE_SPLIT } from "./linux-native.js";

/** 目标 Windows node.exe 可执行文件名（zip 内）。 */
const WIN_NODE_EXE = "node.exe";

/** 运行时缓存子目录名（<数据根>/runtime/win-node/）。 */
export const WIN_NODE_DIR_NAME = "win-node";

/** Windows node.exe 定位结果。 */
export interface WinNodeInfo {
    /** node.exe 绝对路径（供 stub QQNT.dll 转发目标进程使用）。 */
    exePath: string;
    /** 已下载的完整版 node zip 版本号（如 v24.16.0）。 */
    version: string;
}

/** 解析 nodejs.org zip URL（与 dist 目录命名一致）。 */
export function nodeZipUrl(version: string): string {
    return `https://nodejs.org/dist/${version}/node-${version}-win-x64.zip`;
}

/**
 * 确保 Windows 版 node.exe 就绪（下载 + 解压 + 缓存）。
 * 幂等：<数据根>/runtime/win-node/<version>/node.exe 已存在则直接返回。
 */
export async function ensureWinNode(
    options: {
        /** 数据根（缓存 <数据根>/runtime/win-node/）。 */
        dataRoot?: string;
        /** node 版本（缺省读 NAPUKETTO_WIN_NODE_VERSION，再兜底 latest v24）。 */
        version?: string;
        /** 显式 node.exe 路径（覆盖缓存逻辑，读 NAPUKETTO_WIN_NODE_PATH）。 */
        exePath?: string;
    } = {},
): Promise<WinNodeInfo> {
    // 显式路径覆盖（NAPUKETTO_WIN_NODE_PATH / exePath 参数）
    const explicit = options.exePath ?? process.env["NAPUKETTO_WIN_NODE_PATH"];
    if (explicit !== undefined && explicit !== "" && existsSync(explicit)) {
        return { exePath: resolve(explicit), version: "explicit" };
    }

    const version =
        options.version ?? process.env["NAPUKETTO_WIN_NODE_VERSION"] ?? DEFAULT_WIN_NODE_VERSION;
    const dataRoot = resolveDataRoot(options.dataRoot);
    const cacheDir = join(dataRoot, "runtime", WIN_NODE_DIR_NAME, version);
    const exePath = join(cacheDir, WIN_NODE_EXE);
    if (existsSync(exePath)) {
        return { exePath, version };
    }

    // 下载 zip + 解压（7z 直接支持 zip）
    const zipPath = join(cacheDir, `node-${version}-win-x64.zip`);
    const url = process.env["NAPUKETTO_WIN_NODE_URL"] ?? nodeZipUrl(version);
    mkdirSync(cacheDir, { recursive: true });
    try {
        await downloadFile({ dest: zipPath, url });
        await unzipNode(zipPath, cacheDir);
    } finally {
        await rm(zipPath, { force: true });
    }
    if (!existsSync(exePath)) {
        throw new Error(`解压后未找到 node.exe: ${exePath}`);
    }
    return { exePath, version };
}

/** 解压 node zip（zip 内为 node-<version>-win-x64/ 目录，取其中 node.exe 移到缓存根）。 */
async function unzipNode(zipPath: string, cacheDir: string): Promise<void> {
    const tmpDir = join(cacheDir, "_zip");
    await extractInstaller(zipPath, tmpDir);
    // zip 顶层是 node-<version>-win-x64/，找其中 node.exe
    const top = await readdir(tmpDir);
    const nodeDir = top.find((n) => n.startsWith("node-"));
    const src =
        nodeDir === undefined ? join(tmpDir, WIN_NODE_EXE) : join(tmpDir, nodeDir, WIN_NODE_EXE);
    if (!existsSync(src)) {
        throw new Error(`node zip 解压后未找到 node.exe: ${src}`);
    }
    await copyFile(src, join(cacheDir, WIN_NODE_EXE));
    await rm(tmpDir, { recursive: true, force: true });
}

/**
 * 默认 Windows node 版本（latest v24，LTS 线；可被环境变量/参数覆盖）。
 * ⚠️ nodejs.org/dist 保留历史版本不会 404，但 pin 死旧 patch 收不到安全更新——
 * 升级 Windows node 时记得同步 bump 此常量（或经 NAPUKETTO_WIN_NODE_VERSION 覆盖）。
 */
const DEFAULT_WIN_NODE_VERSION = "v24.16.0";

/**
 * 解析宿主 node 可执行（win32）：标准 node 宿主直接用自身（返回 undefined，调用方
 * 回退 process.execPath）；非 node 宿主（koishi CE 等 Bun 运行时，execPath=bun.exe）
 * 必须解析真 node——wrapper.node 的符号由 stub QQNT.dll 绑定到 node.exe，bun.exe
 * 进程内无此模块，LoadLibrary 报 1114「DLL 初始化例程失败」（实测）。
 */
export async function resolveHostNodePath(options: {
    winNodePath?: string | undefined;
    cwd?: string | undefined;
    onStage?: ((message: string) => void) | undefined;
}): Promise<string | undefined> {
    if (isNodeExecutable(process.execPath)) {
        return undefined;
    }
    return resolveWinHostNode({
        ...(options.winNodePath !== undefined ? { explicitPath: options.winNodePath } : {}),
        ...(options.cwd !== undefined ? { dataRoot: options.cwd } : {}),
        ...(options.onStage !== undefined ? { onStage: options.onStage } : {}),
    });
}

/** 可执行文件名是否 node（win32 宿主判定；node.exe / node 两种形态）。 */
export function isNodeExecutable(execPath: string): boolean {
    // 反斜杠 Windows 路径先归一化：posix basename 不认 `\` 分隔符，整个字符串
    // 当文件名比对恒 false
    const name = basename(execPath.replaceAll("\\", "/")).toLowerCase();
    return name === "node.exe" || name === "node";
}

/** 系统 node 探测结果（win32，PATH 解析 + 可执行校验）。 */
export interface SystemNodeInfo {
    exePath: string;
    version: string;
}

/** 探测系统 PATH 上的 node（win32；where node 首条 + --version 校验可执行）。 */
export function findSystemNode(): SystemNodeInfo | undefined {
    const probe = spawnSync("where", ["node"], {
        stdio: "pipe",
        encoding: "utf8",
        windowsHide: true,
    });
    if (probe.status !== 0 || !probe.stdout) {
        return undefined;
    }
    const first = probe.stdout
        .split(LINE_SPLIT)
        .map((line) => line.trim())
        .find((line) => line !== "");
    if (first === undefined || !existsSync(first)) {
        return undefined;
    }
    const ver = spawnSync(first, ["--version"], {
        stdio: "pipe",
        encoding: "utf8",
        windowsHide: true,
    });
    const version = ver.status === 0 ? ver.stdout.trim() : "";
    if (!version.startsWith("v")) {
        return undefined;
    }
    return { exePath: resolve(first), version };
}

/** resolveWinHostNode 测试注入面（探测/下载替换为假实现）。 */
export interface WinHostNodeResolvers {
    findSystemNode?: () => SystemNodeInfo | undefined;
    ensureWinNode?: typeof ensureWinNode;
}

/**
 * win32 非 node 宿主时解析真 node.exe：显式覆盖（winNodePath 参数 /
 * NAPUKETTO_WIN_NODE_PATH）> 系统 PATH node（离线可用，免下载）> ensureWinNode
 * 下载（缓存幂等）。显式路径不存在时静默跳过（与 ensureWinNode 行为一致）。
 */
export async function resolveWinHostNode(
    options: {
        explicitPath?: string;
        dataRoot?: string;
        onStage?: (message: string) => void;
    },
    resolvers: WinHostNodeResolvers = {},
): Promise<string | undefined> {
    const findSystem = resolvers.findSystemNode ?? findSystemNode;
    const ensure = resolvers.ensureWinNode ?? ensureWinNode;

    const explicit = options.explicitPath ?? process.env["NAPUKETTO_WIN_NODE_PATH"];
    if (explicit !== undefined && explicit !== "" && existsSync(explicit)) {
        const exePath = resolve(explicit);
        options.onStage?.(`使用显式指定 node：${exePath}`);
        return exePath;
    }

    options.onStage?.(
        `当前宿主非 node（${basename(process.execPath)}），解析 Windows 版 node.exe…`,
    );

    const sys = findSystem();
    if (sys !== undefined) {
        options.onStage?.(`系统 node ${sys.version}：${sys.exePath}`);
        return sys.exePath;
    }

    const winNode = await ensure({
        ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    });
    options.onStage?.(`Windows 版 node.exe 就绪：${winNode.exePath}（${winNode.version}）`);
    return winNode.exePath;
}
