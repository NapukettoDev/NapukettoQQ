import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve existing symlinks and junctions, including those above a missing destination. */
export function resolveExistingPath(path: string): string {
    let existing = resolve(path);
    const missing: string[] = [];
    while (lstatSync(existing, { throwIfNoEntry: false }) === undefined) {
        const parent = dirname(existing);
        if (parent === existing) {
            throw new Error(`找不到路径的真实祖先: ${path}`);
        }
        missing.push(basename(existing));
        existing = parent;
    }
    return join(realpathSync(existing), ...missing.reverse());
}

export function isPathWithin(root: string, path: string): boolean {
    const fromRoot = relative(root, path);
    return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}
