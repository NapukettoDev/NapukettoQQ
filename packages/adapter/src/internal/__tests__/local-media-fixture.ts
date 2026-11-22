import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

export function useLocalMediaFixture() {
    let root = "";
    beforeEach(() => {
        root = realpathSync.native(mkdtempSync(join(tmpdir(), "nk-action-media-")));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));
    return {
        roots: () => [root],
        file: (name: string) => {
            const path = join(root, name);
            writeFileSync(path, name);
            return path;
        },
    };
}
