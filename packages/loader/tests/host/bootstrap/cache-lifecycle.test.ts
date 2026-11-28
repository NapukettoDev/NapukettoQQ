import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { expect, it, vi } from "vitest";
import { bootstrapWithCore } from "../../../src/host/bootstrap/core.js";
import type { IpcServerOptions } from "../../../src/host/ipc/server.js";
import type { KernelServices } from "../../../src/host/protocols/kernel-services.js";
import { createState } from "../../../src/host/runtime/state.js";
import type { KernelLike } from "../../../src/host/runtime/types.js";
import { requestShutdown } from "../../../src/lifecycle/shutdown.js";

const { assemble, attachIpc, attachOb11, captureLoginControl } = vi.hoisted(() => ({
    assemble: vi.fn(),
    attachIpc: vi.fn(),
    attachOb11: vi.fn(),
    captureLoginControl: vi.fn(),
}));
vi.mock("../../../src/shared/boot-log.js", () => ({ log: vi.fn() }));
vi.mock("../../../src/host/auth/login.js", () => ({
    doLogin: async () => ({ uin: "12345", uid: "u_fixture" }),
    pickLoginAccount: vi.fn(),
}));
vi.mock(import("../../../src/host/auth/relogin.js"), async (original) => ({
    ...(await original()),
    createLoginControlHandler: captureLoginControl,
}));
vi.mock("../../../src/host/auth/session.js", () => ({
    replaceSession: vi.fn(),
    activateSession: vi.fn(),
    waitSessionReady: vi.fn(),
    probeCreatedSession: vi.fn(),
    probeSessionMethods: vi.fn(),
    startSessionProbe: vi.fn(),
}));
vi.mock("../../../src/host/bootstrap/probe.js", () => ({
    runProbePhase: vi.fn(),
    runListenerRecordingPhase: vi.fn(),
    runSmokeIfEnabled: vi.fn(),
}));
vi.mock("../../../src/host/ipc/attach.js", () => ({
    attachIpcServices: attachIpc,
    createIpcActionsForCore: () => [],
}));
vi.mock("../../../src/host/ipc/ob11-bridge.js", () => ({ attachOb11IpcBridge: attachOb11 }));
vi.mock("../../../src/host/ipc/sender.js", () => ({ sendLogin: vi.fn(), sendStatus: vi.fn() }));
vi.mock("../../../src/host/protocols/protocols.js", () => ({ startProtocols: assemble }));

it("软重登与关停均先让协议停用，再释放缓存所属的服务", async () => {
    const home = await mkdtemp(join(tmpdir(), "napuketto-cache-lifecycle-"));
    const calls: string[] = [];
    const exit = new Error("fixture process exit");
    const processExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw exit;
    });
    try {
        for (const generation of [1, 2]) {
            assemble.mockResolvedValueOnce({
                stopAdapters: async () => {
                    calls.push(`adapters-${generation}`);
                },
                dispose: () => {
                    calls.push(`services-${generation}`);
                },
            } satisfies Pick<KernelServices, "stopAdapters" | "dispose">);
            attachIpc.mockReturnValueOnce(() => {
                calls.push(`ipc-${generation}`);
            });
            attachOb11.mockResolvedValueOnce(() => {
                calls.push(`ob11-${generation}`);
            });
        }
        const kernel = {
            ["NapukettoCore"]: { create: () => ({ attachWrapper: () => ({}), login: vi.fn() }) },
        } as unknown as KernelLike;
        const ipc = { actions: new Map() } satisfies IpcServerOptions;
        await expect(
            bootstrapWithCore(
                kernel,
                createState(),
                {
                    qqVersion: "fixture",
                    dataDir: home,
                    dataRoot: home,
                    wrapperPath: "",
                },
                "fixture",
                ipc,
            ),
        ).resolves.toBe(true);

        type Reassemble = (result: { uin: string; uid: string }) => Promise<boolean>;
        const callbacks = captureLoginControl.mock.calls[0]?.[3] as
            | { reassemble: Reassemble }
            | undefined;
        expect(callbacks).toBeDefined();
        const reassemble = callbacks?.reassemble;
        if (reassemble === undefined) {
            throw new Error("fixture login callback missing");
        }
        await expect(reassemble({ uin: "23456", uid: "u_next" })).resolves.toBe(true);
        expect(calls).toEqual(["ob11-1", "adapters-1", "ipc-1", "services-1"]);

        await expect(requestShutdown("fixture")).rejects.toBe(exit);
        expect(calls.slice(4)).toEqual(["ob11-2", "adapters-2", "ipc-2", "services-2"]);
        expect(processExit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
        processExit.mockRestore();
        await rm(home, { recursive: true, force: true });
    }
});
