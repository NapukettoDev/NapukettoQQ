/**
 * Milky 群文件类动作测试（group-file.ts，2026-11-14 域对齐重组，自
 * p3-group-file + p1-actions/p2-batch2 群文件用例归并）
 *
 * 锁定：get_group_files 的文件/文件夹实体映射（fileSize 字符串数值化、
 * folder 元数据防御读取）、move/rename/delete/persist 的参数透传（target
 * 缺省根目录）、create_group_folder 返回 folder_id、upload_group_file
 * 走闪传（file:// 展开 + 上传文件集 + 卡片，file_id = fileSetId）、download_url、
 * rename_group_folder、schema 边界（空 id → -400）。
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    type CanonicalElement,
    ChatType,
    type FlashTransferUploadOptions,
    type Peer,
} from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { type ApiOverrides, actionOf, buildMilkyApi, registryOf } from "./test-support.js";

/** 群文件类依赖桩（richMediaApi 全方法 vi.fn，可覆写）。 */
function fileRegistry(overrides: ApiOverrides = {}): ReturnType<typeof registryOf> {
    return registryOf(
        buildMilkyApi({
            richMediaApi: {
                getGroupFileList: vi.fn(async () => []),
                moveGroupFile: vi.fn(async () => undefined),
                renameGroupFile: vi.fn(async () => undefined),
                deleteGroupFile: vi.fn(async () => undefined),
                transGroupFile: vi.fn(async () => undefined),
                createGroupFolder: vi.fn(async () => "folder-new"),
                deleteGroupFolder: vi.fn(async () => undefined),
                getGroupFileDownloadUrl: vi.fn(async () => "https://dl.example/f"),
                renameGroupFolder: vi.fn(async () => undefined),
                ...overrides.richMediaApi,
            },
            msgApi: {
                sendMessage: vi.fn(async (_peer: Peer, _elements: CanonicalElement[]) => ({
                    msgId: "m-up",
                })),
                fetchMsgsByMsgId: vi.fn(async () => []),
                ...overrides.msgApi,
            },
            ...overrides,
        }),
    );
}

describe("get_group_files", () => {
    it("文件实体：fileSize 字符串数值化 + 无源字段兜底", async () => {
        const getGroupFileList = vi.fn(async () => [
            {
                fileInfo: {
                    fileId: "f1",
                    fileName: "a.zip",
                    fileSize: "2048",
                    parent: "d1",
                    uploadTime: 1760000000,
                    uploaderUin: "20002",
                },
            },
            { fileInfo: { fileId: "f2", fileName: "b.bin", fileSize: "bad", uploadTime: "x" } },
        ]);
        const registry = fileRegistry({ richMediaApi: { getGroupFileList } });
        const res = await actionOf(registry, "get_group_files").handle({ group_id: 10001 });
        const data = res.data as { files: Record<string, unknown>[]; folders: unknown[] };
        expect(data.files[0]).toEqual({
            group_id: 10001,
            file_id: "f1",
            file_name: "a.zip",
            parent_folder_id: "d1",
            file_size: 2048,
            uploaded_time: 1760000000,
            expire_time: null,
            uploader_id: 20002,
            downloaded_times: 0,
        });
        expect(data.files[1]).toMatchObject({
            file_size: 0,
            uploaded_time: 0,
            parent_folder_id: "",
        });
        expect(data.folders).toEqual([]);
        expect(getGroupFileList).toHaveBeenCalledWith("10001", "");
    });

    it("文件夹实体：number/字符串元数据均取值", async () => {
        const getGroupFileList = vi.fn(async () => [
            {
                folderInfo: {
                    folderId: "d1",
                    folderName: "资料",
                    folderUid: "root",
                    createTime: 1760000000,
                    modifyTime: "1760000100",
                    totalFileCount: "3",
                },
            },
            { other: true },
        ]);
        const registry = fileRegistry({ richMediaApi: { getGroupFileList } });
        const res = await actionOf(registry, "get_group_files").handle({ group_id: 10001 });
        const data = res.data as { folders: Record<string, unknown>[] };
        expect(data.folders[0]).toEqual({
            group_id: 10001,
            folder_id: "d1",
            parent_folder_id: "root",
            folder_name: "资料",
            created_time: 1760000000,
            last_modified_time: 1760000100,
            creator_id: 0,
            file_count: 3,
        });
        expect(data.folders).toHaveLength(1);
    });

    it("parent_folder_id 透传 getGroupFileList", async () => {
        const getGroupFileList = vi.fn(async () => []);
        const registry = fileRegistry({ richMediaApi: { getGroupFileList } });
        await actionOf(registry, "get_group_files").handle({
            group_id: 10001,
            parent_folder_id: "d9",
        });
        expect(getGroupFileList).toHaveBeenCalledWith("10001", "d9");
    });

    it("文件/文件夹实体字段映射（P1 补测）", async () => {
        const registry = fileRegistry({
            richMediaApi: {
                getGroupFileList: vi.fn(async () => [
                    {
                        fileInfo: {
                            fileId: "f1",
                            fileName: "a.zip",
                            fileSize: "2048",
                            parent: "",
                            uploadTime: 1760000000,
                            uploaderUin: "20002",
                        },
                    },
                    {
                        folderInfo: {
                            folderId: "d1",
                            folderName: "资料",
                            folderUid: "",
                            createTime: 1760000000,
                            modifyTime: 1760000001,
                            totalFileCount: 3,
                        },
                    },
                ]),
            },
        });
        const result = await registry.get("get_group_files")?.handle({ group_id: 10001 });
        const fileData = result?.data as { files: unknown[]; folders: unknown[] } | undefined;
        expect(fileData?.files).toEqual([
            {
                group_id: 10001,
                file_id: "f1",
                file_name: "a.zip",
                parent_folder_id: "",
                file_size: 2048,
                uploaded_time: 1760000000,
                expire_time: null,
                uploader_id: 20002,
                downloaded_times: 0,
            },
        ]);
        expect(fileData?.folders).toEqual([
            {
                group_id: 10001,
                folder_id: "d1",
                parent_folder_id: "",
                folder_name: "资料",
                created_time: 1760000000,
                last_modified_time: 1760000001,
                creator_id: 0,
                file_count: 3,
            },
        ]);
    });
});

describe("move / rename / delete / persist 群文件", () => {
    it("move_group_file：target 缺省移到根目录（空串）", async () => {
        const moveGroupFile = vi.fn(async () => undefined);
        const registry = fileRegistry({ richMediaApi: { moveGroupFile } });
        await actionOf(registry, "move_group_file").handle({
            group_id: 10001,
            file_id: "f1",
        });
        expect(moveGroupFile).toHaveBeenCalledWith("10001", ["f1"], "");
        await actionOf(registry, "move_group_file").handle({
            group_id: 10001,
            file_id: "f1",
            target_folder_id: "d2",
        });
        expect(moveGroupFile).toHaveBeenLastCalledWith("10001", ["f1"], "d2");
    });

    it("rename_group_file / delete_group_file / persist_group_file 透传", async () => {
        const renameGroupFile = vi.fn(async () => undefined);
        const deleteGroupFile = vi.fn(async () => undefined);
        const transGroupFile = vi.fn(async () => undefined);
        const registry = fileRegistry({
            richMediaApi: { renameGroupFile, deleteGroupFile, transGroupFile },
        });
        await actionOf(registry, "rename_group_file").handle({
            group_id: 10001,
            file_id: "f1",
            new_file_name: "新名.zip",
        });
        expect(renameGroupFile).toHaveBeenCalledWith("10001", "f1", "新名.zip");
        await actionOf(registry, "delete_group_file").handle({ group_id: 10001, file_id: "f1" });
        expect(deleteGroupFile).toHaveBeenCalledWith("10001", ["f1"]);
        await actionOf(registry, "persist_group_file").handle({ group_id: 10001, file_id: "f1" });
        expect(transGroupFile).toHaveBeenCalledWith("10001", "f1");
    });

    it("file_id 空串 → -400", async () => {
        const registry = fileRegistry({});
        const res = await actionOf(registry, "delete_group_file").handle({
            group_id: 10001,
            file_id: "",
        });
        expect(res.retcode).toBe(-400);
    });
});

describe("create / delete / rename folder", () => {
    it("create_group_folder：返回 folder_id", async () => {
        const createGroupFolder = vi.fn(async () => "folder-9");
        const registry = fileRegistry({ richMediaApi: { createGroupFolder } });
        const res = await actionOf(registry, "create_group_folder").handle({
            group_id: 10001,
            folder_name: "新目录",
        });
        expect(res.data).toEqual({ folder_id: "folder-9" });
        expect(createGroupFolder).toHaveBeenCalledWith("10001", "新目录");
    });

    it("delete_group_folder / rename_group_folder 透传", async () => {
        const deleteGroupFolder = vi.fn(async () => undefined);
        const renameGroupFolder = vi.fn(async () => undefined);
        const registry = fileRegistry({ richMediaApi: { deleteGroupFolder, renameGroupFolder } });
        await actionOf(registry, "delete_group_folder").handle({
            group_id: 10001,
            folder_id: "d1",
        });
        expect(deleteGroupFolder).toHaveBeenCalledWith("10001", "d1");
        await actionOf(registry, "rename_group_folder").handle({
            group_id: 10001,
            folder_id: "d1",
            new_folder_name: "改名",
        });
        expect(renameGroupFolder).toHaveBeenCalledWith("10001", "d1", "改名");
    });

    it("folder_name 空串 → -400", async () => {
        const registry = fileRegistry({});
        const res = await actionOf(registry, "create_group_folder").handle({
            group_id: 10001,
            folder_name: "",
        });
        expect(res.retcode).toBe(-400);
    });

    it("create_group_folder：空 folder_name → -400（P1 schema 补测）", async () => {
        const registry = fileRegistry({});
        const result = await registry
            .get("create_group_folder")
            ?.handle({ group_id: 10001, folder_name: "" });
        expect(result?.retcode).toBe(-400);
    });

    it("rename_group_folder：参数透传（P2 批次二补测）", async () => {
        const renameGroupFolder = vi.fn(async () => undefined);
        const registry = fileRegistry({ richMediaApi: { renameGroupFolder } });
        await actionOf(registry, "rename_group_folder").handle({
            group_id: 10001,
            folder_id: "fd1",
            new_folder_name: "新名",
        });
        expect(renameGroupFolder).toHaveBeenCalledWith("10001", "fd1", "新名");
    });
});

describe("upload_group_file（闪传通道）", () => {
    it("file:// file_uri 展开 + 走闪传 sendFile（peer/paths/name 对齐）", async () => {
        const sendFile = vi.fn(
            async (_target: Peer, _paths: string[], _options: FlashTransferUploadOptions) => ({
                fileSetId: "fs-9",
                shareLink: "https://qfile.qq.com/q/X",
                fileCount: 1,
            }),
        );
        const registry = fileRegistry({ flashTransferApi: { sendFile } });
        const res = await actionOf(registry, "upload_group_file").handle({
            group_id: 10001,
            file_uri: pathToFileURL(join("tmp", "up.bin")).href,
            file_name: "up.bin",
        });
        expect(res.data).toEqual({ file_id: "fs-9" });
        const [peer, paths, opts] = sendFile.mock.calls[0] ?? [];
        expect(peer).toEqual({ chatType: ChatType.GROUP, peerUid: "10001" });
        // pathToFileURL 会把相对路径解析为绝对路径：断言「file:// 剥离 + 文件名保留」
        expect(paths).toHaveLength(1);
        expect(paths?.[0]?.endsWith(join("tmp", "up.bin"))).toBe(true);
        expect(opts?.name).toBe("up.bin");
    });

    it("裸路径原样传入闪传（不再走消息发送链）", async () => {
        const sendFile = vi.fn(
            async (_target: Peer, _paths: string[], _options: FlashTransferUploadOptions) => ({
                fileSetId: "fs-raw",
                shareLink: "",
                fileCount: 1,
            }),
        );
        const registry = fileRegistry({ flashTransferApi: { sendFile } });
        const res = await actionOf(registry, "upload_group_file").handle({
            group_id: 10001,
            file_uri: "raw.bin",
            file_name: "raw.bin",
        });
        expect(res.data).toEqual({ file_id: "fs-raw" });
        expect((sendFile.mock.calls[0] ?? [])[1]).toEqual(["raw.bin"]);
    });

    it("parent_folder_id 仅 schema 兼容（闪传没有目录概念）", async () => {
        const registry = fileRegistry({});
        const res = await actionOf(registry, "upload_group_file").handle({
            group_id: 10001,
            parent_folder_id: "d1",
            file_uri: "x.bin",
            file_name: "x.bin",
        });
        expect(res.status).toBe("ok");
    });

    it("群 peer + parent_folder_id 仅 schema 兼容（P2 批次二补测）", async () => {
        const sendFile = vi.fn(
            async (_target: Peer, _paths: string[], _options: FlashTransferUploadOptions) => ({
                fileSetId: "fs-group",
                shareLink: "",
                fileCount: 1,
            }),
        );
        const registry = fileRegistry({ flashTransferApi: { sendFile } });
        const res = await actionOf(registry, "upload_group_file").handle({
            group_id: 10001,
            parent_folder_id: "/",
            file_uri: "file:///C:/a.zip",
            file_name: "a.zip",
        });
        expect(res.retcode).toBe(0);
        expect(sendFile).toHaveBeenCalledWith(
            expect.objectContaining({ chatType: 2, peerUid: "10001" }),
            [expect.stringMatching(/a\.zip$/)],
            { name: "a.zip" },
        );
    });
});

describe("get_group_file_download_url", () => {
    it("download_url 透传（url 字段待实机校准）", async () => {
        const getGroupFileDownloadUrl = vi.fn(async () => "https://dl.example/f");
        const registry = fileRegistry({ richMediaApi: { getGroupFileDownloadUrl } });
        const res = await actionOf(registry, "get_group_file_download_url").handle({
            group_id: 10001,
            file_id: "f1",
        });
        expect(res.data).toEqual({ download_url: "https://dl.example/f" });
        expect(getGroupFileDownloadUrl).toHaveBeenCalledWith("10001", "f1");
    });

    it("kernel 抛错 → 映射表 retcode（NOT_FOUND → -404）", async () => {
        const { kernelError } = await import("@napuketto/kernel");
        const registry = fileRegistry({
            richMediaApi: {
                getGroupFileDownloadUrl: vi.fn(async () => {
                    throw kernelError("文件不存在", "NOT_FOUND");
                }),
            },
        });
        const res = await actionOf(registry, "get_group_file_download_url").handle({
            group_id: 10001,
            file_id: "missing",
        });
        expect(res.retcode).toBe(-404);
    });

    it("download_url 透传（P2 批次二补测）", async () => {
        const registry = fileRegistry({
            richMediaApi: {
                getGroupFileDownloadUrl: vi.fn(async () => "https://dl/x"),
            },
        });
        const res = await actionOf(registry, "get_group_file_download_url").handle({
            group_id: 10001,
            file_id: "f1",
        });
        expect(res.data).toEqual({ download_url: "https://dl/x" });
    });
});
