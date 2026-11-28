import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

// FileName goes through the Windows file association API. The path is data even
// when it contains PowerShell metacharacters or a literal %variable%.
const OPEN_ASSOCIATION = [
    "$ErrorActionPreference = 'Stop'",
    "$info = New-Object System.Diagnostics.ProcessStartInfo",
    "$info.FileName = $env:NAPUKETTO_OPEN_CONFIG",
    "$info.UseShellExecute = $true",
    "[void][System.Diagnostics.Process]::Start($info)",
].join("; ");

export type StartOpener = (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
) => ChildProcess;

export async function openConfig(
    file: string,
    platform: NodeJS.Platform = process.platform,
    start: StartOpener = spawn,
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const systemRoot = process.env["SystemRoot"];
        if (platform === "win32") {
            if (!systemRoot) {
                resolve(false);
                return;
            }
            const powershell = join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
            const child = start(
                powershell,
                ["-NoProfile", "-NonInteractive", "-Command", OPEN_ASSOCIATION],
                {
                    env: { ...process.env, NAPUKETTO_OPEN_CONFIG: file },
                    stdio: "ignore",
                    windowsHide: true,
                    signal: AbortSignal.timeout(10_000),
                },
            );
            child.once("error", () => resolve(false));
            child.once("exit", (code) => resolve(code === 0));
            return;
        }

        const child = start(platform === "darwin" ? "open" : "xdg-open", [file], {
            stdio: "ignore",
            detached: true,
        });
        child.once("error", () => resolve(false));
        child.once("spawn", () => {
            child.unref();
            resolve(true);
        });
    }).catch(() => false);
}
