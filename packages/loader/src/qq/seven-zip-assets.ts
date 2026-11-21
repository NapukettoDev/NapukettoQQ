import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../../assets/7zip/manifest.json" with { type: "json" };

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
