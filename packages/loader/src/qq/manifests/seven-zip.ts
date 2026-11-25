/**
 * manifests/seven-zip.ts：内置 7-Zip 资产清单读取与摘要校验。
 *
 * ⚠️ 零 TS 源码相对 import：`tooling/qq-releases/update-qq-releases.ts` 由 `node`
 * 直接执行（CI 定时任务与本地兜底共用，无构建、无 tsconfig），Node 的类型剥离
 * 不会把 `./x.js` 说明符改写成 `./x.ts`。这里只依赖 node 内置模块与静态 JSON
 * 资产（`../../../assets/7zip/manifest.json`）；守卫见
 * `tooling/qq-releases/update-qq-releases.import.test.ts`。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../../../assets/7zip/manifest.json" with { type: "json" };

export const linuxSevenZip = manifest["linux-x64"];
export const windowsSevenZip = manifest["windows-x64"];

export function matchesSevenZipHash(file: string, expectedSha256: string): boolean {
    return createHash("sha256").update(readFileSync(file)).digest("hex") === expectedSha256;
}

export function assertSevenZipHash(file: string, expectedSha256: string): void {
    if (!matchesSevenZipHash(file, expectedSha256)) {
        throw new Error(`7-Zip 文件 SHA-256 校验失败: ${file}`);
    }
}

export function findBundledSevenZip(assetsDir: string, platform: "win32" | "linux"): string | null {
    const exe = join(assetsDir, platform === "win32" ? "7z.exe" : "7zz");
    if (!existsSync(exe)) {
        return null;
    }
    if (platform === "win32") {
        assertSevenZipHash(exe, windowsSevenZip.files["7z.exe"]);
        assertSevenZipHash(join(assetsDir, "7z.dll"), windowsSevenZip.files["7z.dll"]);
    } else {
        assertSevenZipHash(exe, linuxSevenZip.files["7zz"]);
    }
    return exe;
}
