import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
    assertNoProtocolLeftovers,
    discoverPackages,
    parseCatalogSpecs,
    rewriteDependencyProtocols,
} from "./release-npm-core.ts";

const LOADER_DIR = "packages/loader";
const NATIVE_DIR = `${LOADER_DIR}/native`;
const STUBS = ["prebuilt/win32-x64/QQNT.dll", "prebuilt/linux-x64/libnapuketto_stub.so"];
const NATIVE_FILES = new Set([
    ...STUBS.map((stub) => `package/native/${stub}`),
    "package/native/prebuilt/win32-x64/NOTICE.md",
]);

function archiveEntry(archive: string, listing: readonly string[], file: string): Buffer {
    if (!listing.includes(file)) {
        throw new Error(`loader tarball is missing ${file}`);
    }
    return execFileSync("tar", ["-xOf", archive, file]);
}

function checkLoaderArchive(root: string, archive: string): void {
    const gitlink = execFileSync("git", ["rev-parse", `HEAD:${NATIVE_DIR}`], {
        cwd: root,
        encoding: "utf8",
    }).trim();
    const native = join(root, NATIVE_DIR);
    const checkout = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: native,
        encoding: "utf8",
    }).trim();
    if (checkout !== gitlink) {
        throw new Error(`loader native checkout ${checkout} does not match gitlink ${gitlink}`);
    }

    const listing = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/);
    if (listing.some((file) => file.startsWith("package/native/") && !NATIVE_FILES.has(file))) {
        throw new Error("loader tarball contains unexpected files under native/");
    }
    for (const stub of STUBS) {
        const expected = execFileSync("git", ["show", `${gitlink}:${stub}`], { cwd: native });
        const entry = archiveEntry(archive, listing, `package/native/${stub}`);
        if (expected.length === 0 || !entry.equals(expected)) {
            throw new Error(`loader tarball stub does not match ${gitlink}:${stub}`);
        }
        console.log(
            `native ${gitlink} ${stub} sha256=${createHash("sha256").update(entry).digest("hex")}`,
        );
    }
    for (const file of [
        "dist/index.mjs",
        "dist/index.d.mts",
        "dist/host/self-host.cjs",
        "releases.json",
    ]) {
        const entry = archiveEntry(archive, listing, `package/${file}`);
        if (entry.length === 0) {
            throw new Error(`loader tarball entry is empty: ${file}`);
        }
    }
}

function runPack(dir: string, destination: string): void {
    const options: ExecFileSyncOptions = {
        cwd: dir,
        env: { ...process.env, npm_config_pack_destination: destination },
        stdio: ["ignore", "ignore", "pipe"],
    };
    if (process.platform === "win32") {
        execFileSync(
            process.env["ComSpec"] ?? "cmd.exe",
            ["/d", "/s", "/c", "npm pack --ignore-scripts"],
            options,
        );
    } else {
        execFileSync("npm", ["pack", "--ignore-scripts"], options);
    }
}

export async function packLoader(root: string, destination: string): Promise<void> {
    const packages = await discoverPackages(root);
    const loader = packages.find(({ name }) => name === "@napuketto/loader");
    if (!loader) {
        throw new Error("could not find @napuketto/loader");
    }
    const manifest = join(loader.dir, "package.json");
    const original = readFileSync(manifest, "utf8");
    const workspaceVersions = new Map(packages.map(({ name, version }) => [name, version]));
    const catalog = parseCatalogSpecs(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
    const { text } = rewriteDependencyProtocols(original, workspaceVersions, catalog);
    assertNoProtocolLeftovers(text);

    const tmp = mkdtempSync(join(destination, "napuketto-loader-"));
    try {
        const stage = join(tmp, "package");
        const nativePaths = [...NATIVE_FILES];
        cpSync(loader.dir, stage, {
            recursive: true,
            filter(source) {
                const path = relative(loader.dir, source).split(sep).join("/");
                if (path === "native" || path.startsWith("native/")) {
                    const entry = `package/${path}`;
                    return nativePaths.some(
                        (file) => file === entry || file.startsWith(`${entry}/`),
                    );
                }
                return path !== "node_modules" && path !== ".git";
            },
        });
        writeFileSync(join(stage, "package.json"), text);
        runPack(stage, tmp);
        const archive = join(tmp, `napuketto-loader-${loader.version}.tgz`);
        checkLoaderArchive(root, archive);
        renameSync(archive, join(destination, "loader.tgz"));
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === script) {
    const destination = process.argv[2];
    if (!destination) {
        throw new Error("usage: node tooling/release/pack-loader.ts <existing output directory>");
    }
    await packLoader(resolve(dirname(script), "../.."), resolve(destination));
}
