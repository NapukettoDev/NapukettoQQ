/**
 * flash-transfer.ts FlashTransferApi 测试：
 *  - constructor 空服务 → INVALID_STATE
 *  - uploadFileSet：事件驱动完成 / 多文件 / 缺 fileSetId / 空路径 / 超时 / 监听器注销
 *  - sendCard：targets 由 Peer 映射（destType = chatType、destUid = peerUid）/ 空 fileSetId
 *  - sendFile：上传 + 发卡片一步
 */
import { describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import type { FlashTransferFileSet, FlashTransferUploadListener } from "../../types/index.js";
import { FlashTransferApi } from "../flash-transfer.js";
import { makeSession } from "./test-support.js";

const GROUP_PEER = { chatType: 2 as const, peerUid: "1101729931" };

const FILE_SET: FlashTransferFileSet = {
    fileSetId: "fs-1",
    name: "hello.txt",
    totalFileCount: "1",
    totalFileSize: "52",
    shareInfo: { shareLink: "https://qfile.qq.com/q/TEST" },
};

/**
 * 桩服务：createFlashTransferUploadTask 立即用给定脚本驱动 listener。
 * scripts 是「按顺序调用 listener 的哪个事件」，用来模拟真实事件序列。
 */
function makeService(
    scripts: Array<(l: FlashTransferUploadListener) => void>,
    overrides: Record<string, unknown> = {},
) {
    const listeners: FlashTransferUploadListener[] = [];
    const service = {
        addFileSetUploadListener: vi.fn((l: FlashTransferUploadListener) => {
            listeners.push(l);
        }),
        removeFileSetUploadListener: vi.fn(),
        createFlashTransferUploadTask: vi.fn(
            (l: FlashTransferUploadListener, _taskInfo: unknown) => {
                for (const script of scripts) {
                    script(l);
                }
                return {};
            },
        ),
        sendFlashTransferMsg: vi.fn(async () => ({ result: 0, errMsg: "" })),
        ...overrides,
    };
    const api = new FlashTransferApi(makeSession({ getFlashTransferService: () => service }));
    return { api, service, listeners };
}

/** 上传完成的脚本（先给文件集快照，再逐文件 finished）。 */
function finishScript(cliFileIds: string[], fileSet: FlashTransferFileSet | null = FILE_SET) {
    return [
        (l: FlashTransferUploadListener) => {
            if (fileSet !== null) {
                l.onFileSetUploadStatusChanged?.(fileSet);
            }
        },
        ...cliFileIds.map(
            (id) => (l: FlashTransferUploadListener) =>
                l.onFileDidFinishUpload?.({ fileSetId: "fs-1", cliFileId: id, name: "hello.txt" }),
        ),
    ];
}

describe("constructor", () => {
    it("getFlashTransferService 空 / undefined → INVALID_STATE", () => {
        expect(
            () => new FlashTransferApi(makeSession({ getFlashTransferService: () => null })),
        ).toThrow(/getFlashTransferService\(\) 返回空/);
        expect(
            () => new FlashTransferApi(makeSession({ getFlashTransferService: () => undefined })),
        ).toThrow(/getFlashTransferService\(\) 返回空/);
    });
});

describe("uploadFileSet", () => {
    it("单文件：等到 onFileDidFinishUpload 后返回 fileSetId + shareLink", async () => {
        const { api, service } = makeService(finishScript(["c1"]));
        const result = await api.uploadFileSet(["/tmp/hello.txt"]);
        expect(result).toEqual({
            fileSetId: "fs-1",
            shareLink: "https://qfile.qq.com/q/TEST",
            fileCount: 1,
        });
        expect(service.createFlashTransferUploadTask).toHaveBeenCalledTimes(1);
        expect(service.removeFileSetUploadListener).toHaveBeenCalledTimes(1);
    });

    it("taskInfo 带默认值：name 取首个文件名、permission.code=0、paths 原样", async () => {
        const { api, service } = makeService(finishScript(["c1"]));
        await api.uploadFileSet(["/tmp/dir/报告.pdf"]);
        const taskInfo = service.createFlashTransferUploadTask.mock.calls[0]?.[1] as {
            name: string;
            permission: { code: number };
            paths: string[];
        };
        expect(taskInfo.name).toBe("报告.pdf");
        expect(taskInfo.permission.code).toBe(0);
        expect(taskInfo.paths).toEqual(["/tmp/dir/报告.pdf"]);
    });

    it("多文件：全部 finished 才返回（缺一个就等）", async () => {
        const { api } = makeService(finishScript(["c1", "c2"]));
        const result = await api.uploadFileSet(["/tmp/a.txt", "/tmp/b.txt"]);
        expect(result.fileCount).toBe(2);
    });

    it("同一 cliFileId 去重：重复事件不会提前判定完成", async () => {
        const { api } = makeService(finishScript(["c1", "c1"]));
        await expect(
            api.uploadFileSet(["/tmp/a.txt", "/tmp/b.txt"], { timeoutMs: 30 }),
        ).rejects.toThrow(/闪传上传超时/);
    });

    it("事件没有 fileSetId → UNKNOWN", async () => {
        const { api } = makeService(
            finishScript(["c1"], { fileSetId: "", shareInfo: { shareLink: "" } }),
        );
        await expect(api.uploadFileSet(["/tmp/a.txt"])).rejects.toThrow(/未取到 fileSetId/);
    });

    it("shareLink 缺失 → 返回空串（fileSetId 为准）", async () => {
        const { api } = makeService(finishScript(["c1"], { fileSetId: "fs-1" }));
        const result = await api.uploadFileSet(["/tmp/a.txt"]);
        expect(result.shareLink).toBe("");
    });

    it("空路径列表 → INVALID_PARAM", async () => {
        const { api, service } = makeService([]);
        await expect(api.uploadFileSet([])).rejects.toThrow(/至少一个文件路径/);
        expect(service.createFlashTransferUploadTask).not.toHaveBeenCalled();
    });

    it("超时 → TIMEOUT，且仍注销监听器", async () => {
        const { api, service } = makeService([]);
        await expect(api.uploadFileSet(["/tmp/a.txt"], { timeoutMs: 20 })).rejects.toBeInstanceOf(
            KernelError,
        );
        expect(service.removeFileSetUploadListener).toHaveBeenCalledTimes(1);
    });

    it("原生调用抛错 → UNKNOWN 且带 cause", async () => {
        const { api } = makeService([], {
            createFlashTransferUploadTask: vi.fn(() => {
                throw new Error("boom");
            }),
        });
        await expect(api.uploadFileSet(["/tmp/a.txt"])).rejects.toThrow(
            /createFlashTransferUploadTask 失败: boom/,
        );
    });
});

describe("sendCard", () => {
    it("targets 由 Peer 映射：destType=chatType、destUid=peerUid", async () => {
        const { api, service } = makeService([]);
        await api.sendCard(GROUP_PEER, "fs-1");
        expect(service.sendFlashTransferMsg).toHaveBeenCalledWith({
            targets: [{ destType: 2, destUid: "1101729931" }],
            fileSetId: "fs-1",
        });
    });

    it("私聊走 uid（peerUid 即 uid）", async () => {
        const { api, service } = makeService([]);
        await api.sendCard({ chatType: 1, peerUid: "u__abc" }, "fs-2");
        expect(service.sendFlashTransferMsg).toHaveBeenCalledWith({
            targets: [{ destType: 1, destUid: "u__abc" }],
            fileSetId: "fs-2",
        });
    });

    it("空 fileSetId → INVALID_PARAM", async () => {
        const { api, service } = makeService([]);
        await expect(api.sendCard(GROUP_PEER, "")).rejects.toThrow(/需要 fileSetId/);
        expect(service.sendFlashTransferMsg).not.toHaveBeenCalled();
    });
});

describe("sendFile", () => {
    it("上传完成后按 fileSetId 发卡片", async () => {
        const { api, service } = makeService(finishScript(["c1"]));
        const result = await api.sendFile(GROUP_PEER, ["/tmp/hello.txt"]);
        expect(result.fileSetId).toBe("fs-1");
        expect(service.sendFlashTransferMsg).toHaveBeenCalledWith({
            targets: [{ destType: 2, destUid: "1101729931" }],
            fileSetId: "fs-1",
        });
    });
});
