import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../../internal/package-root.js";
import {
    assertSevenZipHash,
    findBundledSevenZip,
    linuxSevenZip,
    windowsSevenZip,
} from "../seven-zip-assets.js";

const assetsDir = join(packageRoot(), "assets", "7zip");

describe("内置 7-Zip 资产清单", () => {
    it("内置资产及许可证的入库字节与清单摘要一致", () => {
        const files = { ...linuxSevenZip.files, ...windowsSevenZip.files };
        expect(readdirSync(assetsDir).sort()).toEqual(
            [...Object.keys(files), "manifest.json"].sort(),
        );
        for (const [name, sha256] of Object.entries(files)) {
            assertSevenZipHash(join(assetsDir, name), sha256);
        }
    });

    it.skipIf(process.platform === "win32")("Linux 7zz 保留执行位", () => {
        expect(statSync(join(assetsDir, "7zz")).mode & 0o111).toBe(0o111);
    });

    it("Windows 内置 7z.exe 不接受已损坏的 DLL", () => {
        const dir = mkdtempSync(join(tmpdir(), "napuketto-7zip-"));
        try {
            copyFileSync(join(assetsDir, "7z.exe"), join(dir, "7z.exe"));
            writeFileSync(join(dir, "7z.dll"), "corrupt DLL");
            expect(() => findBundledSevenZip(dir, "win32")).toThrow(/SHA-256.*7z\.dll/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
