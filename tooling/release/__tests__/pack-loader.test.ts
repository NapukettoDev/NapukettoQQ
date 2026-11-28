import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { packLoader } from "../pack-loader.ts";

function git(cwd: string, ...args: string[]): string {
    return execFileSync(
        "git",
        [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "-c",
            "commit.gpgsign=false",
            ...args,
        ],
        { cwd, encoding: "utf8" },
    ).trim();
}

it("转交与 gitlink 对应的真实 npm tarball，stub 字节变化或缺件时拒绝打包", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "napuketto-pack-"));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const loader = join(root, "packages/loader");
    const native = join(loader, "native");
    const out = join(root, "out");
    const manifest = JSON.stringify({
        name: "@napuketto/loader",
        version: "0.0.0",
        files: ["dist", "native", "releases.json"],
        dependencies: { zod: "catalog:" },
    });
    const stub = join(native, "prebuilt/win32-x64/QQNT.dll");
    const linux = join(native, "prebuilt/linux-x64/libnapuketto_stub.so");
    const files = new Map([
        [stub, "windows stub"],
        [linux, "linux stub"],
        [join(native, "private.cpp"), "private source fixture"],
        [join(loader, "dist/index.mjs"), "export {};"],
        [join(loader, "dist/index.d.mts"), "export {};"],
        [join(loader, "dist/host/self-host.cjs"), "module.exports = {};"],
        [join(loader, "package.json"), manifest],
        [join(loader, "releases.json"), "{}"],
        [join(root, "pnpm-workspace.yaml"), "catalog:\n  zod: ^4.0.0\n"],
    ]);
    for (const [path, contents] of files) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents);
    }
    await mkdir(out);
    git(native, "init", "-q");
    git(native, "add", ".");
    git(native, "commit", "-qm", "native fixture");
    const sha = git(native, "rev-parse", "HEAD");
    git(root, "init", "-q");
    git(root, "update-index", "--add", "--cacheinfo", `160000,${sha},packages/loader/native`);
    git(root, "commit", "-qm", "gitlink fixture");

    await packLoader(root, out);
    const archive = join(out, "loader.tgz");
    const good = await readFile(archive);
    const options = { encoding: "utf8" as const };
    const published = execFileSync("tar", ["-xOf", archive, "package/package.json"], options);
    expect(JSON.parse(published)).toMatchObject({ dependencies: { zod: "^4.0.0" } });
    expect(execFileSync("tar", ["-tf", archive], options)).not.toContain("private.cpp");
    expect(await readFile(join(loader, "package.json"), "utf8")).toBe(manifest);

    await writeFile(stub, "changed stub");
    await expect(packLoader(root, out)).rejects.toThrow("does not match");
    await writeFile(stub, "windows stub");
    await rm(linux);
    await expect(packLoader(root, out)).rejects.toThrow("libnapuketto_stub.so");
    expect(await readFile(archive)).toEqual(good);
}, 15_000);
