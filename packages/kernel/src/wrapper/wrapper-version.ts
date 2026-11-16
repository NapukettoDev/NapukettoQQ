/**
 * QQ 安装目录探测（ADR-018）
 *
 * wrapper.node 路径随 QQ 版本变化：`<安装目录>/versions/<版本>/resources/app/wrapper.node`。
 * 加载前必须知道版本（登录握手参数 appid/qua 与版本强相关）。
 *
 * 已实测确认（2026-08-05，QQ 9.9.31-49919）：
 * - 目录结构：versions/<9.9.31-49919>/resources/app/wrapper.node
 * - 版本信息在 versions/<版本>/resources/app/package.json（name=qq-chat / version / buildVersion）
 * - wrapper.node 是 C++ ABI 模块（非 N-API），导出 INTSessionShell 等符号
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { kernelError } from "../infra/index.js";

/** 从 versions 目录读取版本 package.json（拿 name/version/buildVersion）。 */
function readVersionPackage(
    installDir: string,
    version: string,
): { name: string; version: string; buildVersion?: string } {
    const pkgPath = join(installDir, "versions", version, "resources", "app", "package.json");
    if (!existsSync(pkgPath)) {
        throw kernelError(`QQ 版本目录缺少 package.json: ${pkgPath}`, "NOT_FOUND");
    }
    try {
        const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            name?: string;
            version?: string;
            buildVersion?: string;
        };
        return {
            name: raw.name ?? "",
            version: raw.version ?? "",
            ...(raw.buildVersion !== undefined ? { buildVersion: raw.buildVersion } : {}),
        };
    } catch (cause) {
        throw kernelError(`QQ 版本 package.json 解析失败: ${pkgPath}`, "INVALID_PARAM", { cause });
    }
}

/** 解析 wrapper.node 绝对路径（按 ADR-018 目录约定）。 */
export function resolveWrapperPath(installDir: string, version: string): string {
    return join(installDir, "versions", version, "resources", "app", "wrapper.node");
}

/**
 * 探测指定版本信息（校验 wrapper.node 存在）。
 * 版本号不匹配目录时抛 NOT_FOUND（明确失败而非静默）。
 */
export function resolveQQVersion(installDir: string, version: string): QQVersionInfo {
    const wrapperPath = resolveWrapperPath(installDir, version);
    if (!existsSync(wrapperPath)) {
        throw kernelError(`未找到 wrapper.node: ${wrapperPath}`, "NOT_FOUND");
    }
    const pkg = readVersionPackage(installDir, version);
    return {
        fullVersion: pkg.version || version,
        buildVersion: pkg.buildVersion ?? "",
        wrapperPath,
        appid: "",
        qua: "",
    };
}

/** 扫描 versions 目录，取可加载的版本列表（按目录名倒序，最新在前）。 */
export function listQQVersions(installDir: string): string[] {
    const versionsDir = join(installDir, "versions");
    if (!existsSync(versionsDir)) {
        return [];
    }
    const dirs = readdirSync(versionsDir).filter((name) => {
        const full = join(versionsDir, name);
        return (
            statSync(full).isDirectory() &&
            existsSync(join(full, "resources", "app", "wrapper.node"))
        );
    });
    return dirs.sort().reverse();
}

/** QQ 版本信息。 */
export interface QqVersionInfo {
    /** 完整版本号，如 "9.9.31-49919"。 */
    fullVersion: string;
    /** 构建号，如 "49919"。 */
    buildVersion: string;
    /** wrapper.node 绝对路径。 */
    wrapperPath: string;
    /** 登录握手参数（P1 探测脚本产出，暂为空串）。 */
    appid: string;
    /** 登录握手参数（P1 探测脚本产出，暂为空串）。 */
    qua: string;
}

/** @deprecated 使用 `QqVersionInfo`（缩写大小写统一为 `Qq`）。 */
export type QQVersionInfo = QqVersionInfo;
