import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

export const cliEntry = fileURLToPath(new URL("../../dist/index.mjs", import.meta.url));

export const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(NAPUKETTO_|NODE_OPTIONS$)/i.test(key)),
);

interface CliResult {
    code: number;
    stdout: string;
    stderr: string;
}

interface CliFixture {
    root: string;
    configPath: string;
    dataDir: string;
    run(args: string[], env?: NodeJS.ProcessEnv, nodeArgs?: string[]): Promise<CliResult>;
}

export const cliTest = test.extend("cli", async ({ onTestFinished }): Promise<CliFixture> => {
    const root = await mkdtemp(join(tmpdir(), "napuketto-cli-"));
    const configPath = join(root, "napuketto.toml");
    const dataDir = join(root, "data");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    return {
        root,
        configPath,
        dataDir,
        run: (args, env = {}, nodeArgs = []) =>
            new Promise<CliResult>((resolve, reject) => {
                execFile(
                    process.execPath,
                    [...nodeArgs, cliEntry, "--data-dir", dataDir, ...args],
                    {
                        cwd: root,
                        env: {
                            ...inheritedEnv,
                            NAPUKETTO_CONFIG: configPath,
                            NAPUKETTO_NO_BANNER: "1",
                            ...env,
                        },
                        timeout: 35_000,
                        encoding: "utf8",
                        windowsHide: true,
                    },
                    (error, stdout, stderr) => {
                        const code = error === null ? 0 : error.code;
                        if (typeof code !== "number") {
                            reject(error);
                            return;
                        }
                        resolve({ code, stdout, stderr });
                    },
                );
            }),
    };
});
