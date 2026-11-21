import {
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
    isPathWithin,
    resolveExistingPath,
} from "../../packages/kernel/src/infra/path-boundary.ts";

const MARKER = ".napuketto-sandbox.json";

/** Accept only a sandbox that neither contains nor is contained by the checkout. */
export function resolveSandboxRoot(repo: string, override: string | undefined): string {
    const target = resolve(repo, override?.trim() || "../Debug/napukettoqq-sandbox");
    const realTarget = resolveExistingPath(target);
    for (const path of [target, realTarget]) {
        if (isPathWithin(repo, path) || isPathWithin(path, repo)) {
            throw new Error(`调试沙箱必须位于仓库外，且不得包含仓库: ${path}`);
        }
    }
    return realTarget;
}

/** Check existing account/native write locations, including files managed by QQ itself. */
function checkLinks(root: string, dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink() && !isPathWithin(root, realpathSync(path))) {
            throw new Error(`链接指向调试沙箱外: ${path}`);
        }
        if (entry.isDirectory()) {
            checkLinks(root, path);
        }
    }
}

/** Adopt only an empty directory or an instance already owned by this checkout. */
export function prepareSandbox(root: string, repo: string): void {
    mkdirSync(root, { recursive: true });
    const marker = join(root, MARKER);
    const contents = `${JSON.stringify({ generator: "napukettoqq-sandbox", repo }, null, 4)}\n`;
    if (readdirSync(root).length === 0) {
        try {
            writeFileSync(marker, contents, { flag: "wx" });
        } catch (err) {
            if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) {
                throw err;
            }
        }
    }
    if (
        !lstatSync(marker, { throwIfNoEntry: false })?.isFile() ||
        readFileSync(marker, "utf8") !== contents
    ) {
        throw new Error(`目录已存在且不属于此仓库的调试沙箱: ${root}`);
    }
    checkLinks(root, root);
}
