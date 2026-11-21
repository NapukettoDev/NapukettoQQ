import { resolve } from "node:path";
import process from "node:process";
import { resolveDataRoot, resolveSandboxWritePath } from "@napuketto/kernel";
import type { CliConfig } from "./schema.js";

/** Validate writable settings relative to the same data root used by the CLI and host. */
export function validateSandboxConfigPaths(config: CliConfig, dataDir?: string): void {
    if (!process.env["NAPUKETTO_SANDBOX_ROOT"]) {
        return;
    }
    const dataRoot = resolveDataRoot(dataDir);
    resolveDataRoot(config.dataDir);
    if (config.log?.file !== undefined) {
        resolveSandboxWritePath(resolve(dataRoot, config.log.file.path), "log.file.path");
    }
    for (const account of config.accounts) {
        const cache = account.satori?.["cacheDir"];
        if (typeof cache === "string" && cache !== "") {
            resolveSandboxWritePath(resolve(dataRoot, cache), "accounts.satori.cacheDir");
        }
    }
}
