/**
 * index.test.ts：@napuketto/loader 出口单测（index.ts re-export 面）。
 *
 * 全量 import 出口命名空间，断言关键值导出存在与常量契约——覆盖率上把
 * re-export 语句全部拉进报告（此前 index.ts 从未被任何测试 import，不进分母）。
 */

import { describe, expect, it } from "vitest";
import * as loader from "./index.js";

describe("index 出口面", () => {
    it("定位/下载/解包/关停/锁/IPC 关键值导出存在（函数型）", () => {
        const fns = [
            "acquireInstanceLock",
            "checkInstanceLock",
            "releaseInstanceLock",
            "registerLockCleanup",
            "launchSelfHost",
            "defaultStubDir",
            "resolveQqFiles",
            "resolveQqInstall",
            "ensureQqFiles",
            "ensureLinuxSevenZip",
            "locateQqPath",
            "linuxSevenZipUrl",
            "readCmdlineForPid",
            "downloadFile",
            "clearCacheVersion",
            "extractInstaller",
            "extractWrapperFiles",
            "findSevenZip",
            "loadQqReleases",
            "latestRelease",
            "resolveDownloadUrl",
            "installSignalShutdown",
            "registerShutdownHook",
            "removeStopSentinel",
            "requestShutdown",
            "stopSentinelPath",
            "watchStopSentinel",
            "writeStopSentinel",
            "ensureWinNode",
            "nodeZipUrl",
        ] as const;
        for (const name of fns) {
            expect(typeof (loader as unknown as Record<string, unknown>)[name], name).toBe(
                "function",
            );
        }
    });

    it("错误类可实例化（DownloadError / QqReleasesError）", () => {
        expect(new loader.DownloadError("x").name).toBe("DownloadError");
        expect(new loader.QqReleasesError("y").name).toBe("QqReleasesError");
    });

    it("常量契约：环境变量名与文件名（self-host/cli/koishi 插件共享）", () => {
        expect(loader.ENV["IPC"]).toBe("NAPUTO_IPC");
        expect(loader.ENV["KERNEL_ENTRY"]).toBe("NAPUTO_KERNEL_ENTRY");
        expect(loader.ENV["SELF_HOST"]).toBe("NAPUTO_SELF_HOST");
        expect(loader.ENV["QR_ONLY"]).toBe("NAPUTO_QR_ONLY");
        expect(loader.ENV["DATA_ROOT"]).toBe("NAPUTO_DATA_ROOT");
        expect(loader.STOP_SENTINEL_FILENAME).toBe("napuketto.stop");
        expect(loader.INSTANCE_LOCK_FILE).toBe("instance.lock");
        expect(loader.QQ_FILES_DIR_NAME).toBe("qq-files");
        expect(loader.WIN_NODE_DIR_NAME).toBe("win-node");
    });

    it("IPC 协议契约：版本与 zod schema 出口（koishi 插件同源）", () => {
        expect(loader.IPC_VERSION).toBe(1);
        for (const schema of [
            "IpcMessageSchema",
            "IpcActionPayloadSchema",
            "IpcControlPayloadSchema",
            "IpcStatusPayloadSchema",
            "IpcBootPhaseSchema",
        ] as const) {
            const s = (loader as unknown as Record<string, unknown>)[schema] as {
                parse: (v: unknown) => unknown;
            };
            expect(typeof s.parse, schema).toBe("function");
        }
    });

    it("噪音行判定出口（cli 转发与 IPC 共享单一来源）", () => {
        expect(typeof loader.isNativeNoiseLine).toBe("function");
    });
});
