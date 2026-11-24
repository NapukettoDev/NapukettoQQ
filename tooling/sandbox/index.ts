import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareSandbox, resolveSandboxRoot } from "./paths.ts";

const BUILD_COMMAND = 'pnpm --filter "@napuketto/cli..." build';

async function main(): Promise<void> {
    const [, , mode, ...argv] = process.argv;
    if (mode !== "init" && mode !== "run" && mode !== "config") {
        throw new Error("请从仓库根执行 pnpm sandbox、pnpm dev、pnpm start 或 pnpm run config");
    }
    if (mode === "init" && argv.length > 0) {
        throw new Error("用法: pnpm sandbox（通过 NAPUKETTO_SANDBOX_DIR 指定目录）");
    }
    const repo = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
    const entry = join(repo, "apps", "cli", "dist", "index.mjs");
    if (!existsSync(entry)) {
        throw new Error(`缺少 CLI 构建产物，请先执行 ${BUILD_COMMAND}`);
    }

    const root = resolveSandboxRoot(repo, process.env["NAPUKETTO_SANDBOX_DIR"]);
    prepareSandbox(root, repo);
    const config = join(root, "napuketto.toml");
    const data = join(root, ".napuketto");
    const temp = join(root, "tmp");
    mkdirSync(temp, { recursive: true });

    if (mode === "init") {
        process.stdout.write(`调试沙箱: ${root}\n配置文件: ${config}\n`);
        if (existsSync(config)) {
            return;
        }
    }

    Object.assign(process.env, {
        NAPUKETTO_SANDBOX_ROOT: root,
        NAPUKETTO_CONFIG: config,
        NAPUKETTO_DATA: data,
        NAPUKETTO_LINUX_HOME: join(root, "home"),
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
    });
    const cliArgs = argv[0] === "--" ? argv.slice(1) : argv;
    const args =
        mode === "init" ? ["config", "init"] : mode === "config" ? ["config", ...cliArgs] : cliArgs;
    process.chdir(root);
    // Supervisor and restart use argv[1] to launch the published CLI in child processes.
    process.argv.splice(1, process.argv.length - 1, entry, ...args);
    await import(pathToFileURL(entry).href);
}

try {
    await main();
} catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    if (err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") {
        process.stderr.write(`请检查 pnpm 依赖并执行 ${BUILD_COMMAND}\n`);
    }
    process.exitCode = 1;
}
