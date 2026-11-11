/**
 * win-node.ts：Windows 版 node.exe 获取（**仅 win32**，非 node 宿主场景）。
 *
 * koishi CE 等 Bun 运行时里 execPath=bun.exe，而 PE `wrapper.node` 的宿主符号由 stub
 * `QQNT.dll` 转发到 node.exe——bun.exe 进程内没有该模块，LoadLibrary 报 1114。此时需要
 * 一份真正的 Windows node.exe（优先系统 `where node`，缺失才下载）。
 *
 * ⚠️ 与 Linux 无关：Linux 自建宿主直接跑系统 node（ADR-027 起唯一路径，Wine 已退役）。
 * 来源：nodejs.org 官方 zip（开源软件官方发行版，但为保守起见同样不内置，运行时下载到
 * <数据根>/runtime/win-node/，可被 NAPUTO_WIN_NODE_PATH 覆盖）。
 *
 * 设计文档 §3.1。与 qq-download.ts 同构：https 下载 + 解压 + 缓存幂等。
 */
import { existsSync, mkdirSync } from "node:fs";
import { copyFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { resolveDataRoot } from "../internal/data-root.js";
import { downloadFile } from "../qq/qq-download.js";
import { extractInstaller } from "../qq/qq-extract.js";

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
        /** node 版本（缺省读 NAPUTO_WIN_NODE_VERSION，再兜底 latest v24）。 */
        version?: string;
        /** 显式 node.exe 路径（覆盖缓存逻辑，读 NAPUTO_WIN_NODE_PATH）。 */
        exePath?: string;
    } = {},
): Promise<WinNodeInfo> {
    // 显式路径覆盖（NAPUTO_WIN_NODE_PATH / exePath 参数）
    const explicit = options.exePath ?? process.env["NAPUTO_WIN_NODE_PATH"];
    if (explicit !== undefined && explicit !== "" && existsSync(explicit)) {
        return { exePath: resolve(explicit), version: "explicit" };
    }

    const version =
        options.version ?? process.env["NAPUTO_WIN_NODE_VERSION"] ?? DEFAULT_WIN_NODE_VERSION;
    const dataRoot = resolveDataRoot(options.dataRoot);
    const cacheDir = join(dataRoot, "runtime", WIN_NODE_DIR_NAME, version);
    const exePath = join(cacheDir, WIN_NODE_EXE);
    if (existsSync(exePath)) {
        return { exePath, version };
    }

    // 下载 zip + 解压（用 P1 的 7z 解 zip；7z 支持 zip）
    const zipPath = join(cacheDir, `node-${version}-win-x64.zip`);
    const url = process.env["NAPUTO_WIN_NODE_URL"] ?? nodeZipUrl(version);
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
 * 升级 Windows node 时记得同步 bump 此常量（或经 NAPUTO_WIN_NODE_VERSION 覆盖）。
 */
const DEFAULT_WIN_NODE_VERSION = "v24.16.0";
