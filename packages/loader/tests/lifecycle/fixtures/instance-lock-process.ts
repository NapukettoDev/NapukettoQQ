import { registerHooks } from "node:module";
import process from "node:process";

export type LockCommand = "acquire" | "release" | "register-cleanup";

// Node strips the source types; Loader's relative imports use emitted .js paths.
const sourceRoot = new URL("../../../src/", import.meta.url).href;
registerHooks({
    resolve(specifier, context, nextResolve) {
        const isSourceImport =
            context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".");
        const path =
            isSourceImport && specifier.endsWith(".js")
                ? `${specifier.slice(0, -3)}.ts`
                : specifier;
        return nextResolve(path, context);
    },
});

const { acquireInstanceLock, registerLockCleanup, releaseInstanceLock } = await import(
    "../../../src/lifecycle/instance-lock.ts"
);
const dataDir = process.argv[2];
if (dataDir === undefined || process.send === undefined) {
    throw new Error("Expected an account directory and a parent IPC channel");
}

process.on("message", (command: unknown) => {
    switch (command) {
        case "acquire":
            process.send?.(acquireInstanceLock(dataDir));
            break;
        case "release":
            releaseInstanceLock(dataDir);
            process.send?.("released");
            break;
        case "register-cleanup":
            registerLockCleanup(dataDir);
            process.send?.("registered");
            break;
        case "exit":
            return process.exit(0);
        default:
            throw new Error(`Unexpected lock command: ${String(command)}`);
    }
});
