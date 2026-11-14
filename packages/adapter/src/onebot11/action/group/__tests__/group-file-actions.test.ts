/**
 * 群文件动作测试：查询三件套（root_files / files_by_folder / file_system_info）
 * 与操作六件套（create_folder / delete_file / delete_folder / rename / move / trans）。
 *
 * 锁定行为：fileInfo/folderInfo 拆分与字段映射（可选字段缺省省略）、file_ids 数组
 * 优先于 file_id、folder_id 缺省根目录（空串）、group_id 数字 → 字符串参数、
 * 超限 file_ids → retcode 400。
 */
import { describe, expect, it, vi } from "vitest";
import { ob11ActionOf } from "../../__tests__/test-support.js";
import { createGroupFileOpActions } from "../group-files-op.js";
import { createGroupFileQueryActions } from "../group-files-query.js";

/**
 * 与 group-files-query.ts 的 GroupFileInfo / GroupFolderInfo / GroupFilesResult
 * 同构（生产侧未导出，仅供断言类型标注）。
 */
interface GroupFileInfo {
    file_id: string;
    file_name: string;
    file_size: string;
    uploader?: number;
    upload_time?: number;
    modify_time?: number;
}

/** 同构 GroupFolderInfo。 */
interface GroupFolderInfo {
    folder_id: string;
    folder_name: string;
}

/** 同构 GroupFilesResult。 */
interface GroupFilesResult {
    files: GroupFileInfo[];
    folders: GroupFolderInfo[];
}

describe("get_group_root_files / get_group_files_by_folder", () => {
    it("fileInfo/folderInfo 混合列表 → files/folders 拆分（可选字段映射）", async () => {
        const richMediaApi = {
            getGroupFileList: vi.fn(async () => [
                {
                    fileInfo: {
                        fileId: "f1",
                        fileName: "a.zip",
                        fileSize: "2048",
                        uploaderUin: "90001",
                        uploadTime: 1760000000,
                        modifyTime: 1760000001,
                    },
                },
                { folderInfo: { folderId: "d1", folderName: "资料" } },
                {},
            ]),
        };
        const result = await ob11ActionOf(
            createGroupFileQueryActions({ richMediaApi } as never),
            "get_group_root_files",
        ).handle({ group_id: 808 });
        expect(result.status).toBe("ok");
        expect(result.data).toEqual({
            files: [
                {
                    file_id: "f1",
                    file_name: "a.zip",
                    file_size: "2048",
                    uploader: 90001,
                    upload_time: 1760000000,
                    modify_time: 1760000001,
                },
            ],
            folders: [{ folder_id: "d1", folder_name: "资料" }],
        });
        expect(richMediaApi.getGroupFileList).toHaveBeenCalledWith("808", "", 50);
    });

    it("file_count 覆盖默认值；by_folder 传 folder_id", async () => {
        const richMediaApi = { getGroupFileList: vi.fn(async () => []) };
        const actions = createGroupFileQueryActions({ richMediaApi } as never);
        await ob11ActionOf(actions, "get_group_root_files").handle({
            group_id: 808,
            file_count: 5,
        });
        expect(richMediaApi.getGroupFileList).toHaveBeenLastCalledWith("808", "", 5);
        await ob11ActionOf(actions, "get_group_files_by_folder").handle({
            group_id: 808,
            folder_id: "d9",
        });
        expect(richMediaApi.getGroupFileList).toHaveBeenLastCalledWith("808", "d9", 50);
    });

    it("uploaderUin 缺失 → 可选字段省略；file_count 非法 → 400", async () => {
        const richMediaApi = {
            getGroupFileList: vi.fn(async () => [
                { fileInfo: { fileId: "f2", fileName: "b.txt", fileSize: "1" } },
            ]),
        };
        const actions = createGroupFileQueryActions({ richMediaApi } as never);
        const result = await ob11ActionOf<GroupFilesResult>(actions, "get_group_root_files").handle(
            {
                group_id: 808,
            },
        );
        expect(result.data?.files).toEqual([{ file_id: "f2", file_name: "b.txt", file_size: "1" }]);
        expect(
            (
                await ob11ActionOf(actions, "get_group_root_files").handle({
                    group_id: 808,
                    file_count: "x",
                })
            ).retcode,
        ).toBe(400);
    });
});

describe("get_group_file_system_info", () => {
    it("GroupFileSystemInfo → OB11 字段映射", async () => {
        const richMediaApi = {
            getGroupFileSystemInfo: vi.fn(async () => ({
                fileCount: 3,
                limitCount: 1000,
                usedSpace: 2048,
                totalSpace: 4096,
            })),
        };
        const result = await ob11ActionOf(
            createGroupFileQueryActions({ richMediaApi } as never),
            "get_group_file_system_info",
        ).handle({ group_id: 808 });
        expect(result.data).toEqual({
            file_count: 3,
            limit_count: 1000,
            used_space: 2048,
            total_space: 4096,
        });
    });
});

describe("create_group_file_folder", () => {
    it("createGroupFolder 返回 folder_id", async () => {
        const richMediaApi = { createGroupFolder: vi.fn(async () => "new-folder-id") };
        const result = await ob11ActionOf(
            createGroupFileOpActions({ richMediaApi } as never),
            "create_group_file_folder",
        ).handle({ group_id: 808, folder_name: "相册" });
        expect(result.data).toEqual({ folder_id: "new-folder-id" });
        expect(richMediaApi.createGroupFolder).toHaveBeenCalledWith("808", "相册");
    });

    it("空 folder_name（schema 仅 string，无 min(1)）→ 原样透传", async () => {
        const richMediaApi = { createGroupFolder: vi.fn(async () => "id") };
        const result = await ob11ActionOf(
            createGroupFileOpActions({ richMediaApi } as never),
            "create_group_file_folder",
        ).handle({ group_id: 808, folder_name: "" });
        expect(result.retcode).toBe(0);
        expect(richMediaApi.createGroupFolder).toHaveBeenCalledWith("808", "");
    });
});

describe("delete_group_file / delete_group_folder", () => {
    it("file_id 单数 → ids=[file_id]", async () => {
        const richMediaApi = { deleteGroupFile: vi.fn(async () => undefined) };
        const result = await ob11ActionOf(
            createGroupFileOpActions({ richMediaApi } as never),
            "delete_group_file",
        ).handle({ group_id: 808, file_id: "f1" });
        expect(result.retcode).toBe(0);
        expect(richMediaApi.deleteGroupFile).toHaveBeenCalledWith("808", ["f1"]);
    });

    it("file_ids 数组优先于 file_id（取数组整体）", async () => {
        const richMediaApi = { deleteGroupFile: vi.fn(async () => undefined) };
        await ob11ActionOf(
            createGroupFileOpActions({ richMediaApi } as never),
            "delete_group_file",
        ).handle({ group_id: 808, file_id: "f1", file_ids: ["a", "b"] });
        expect(richMediaApi.deleteGroupFile).toHaveBeenCalledWith("808", ["a", "b"]);
    });

    it("file_ids 超上限（100）→ retcode 400", async () => {
        const richMediaApi = { deleteGroupFile: vi.fn(async () => undefined) };
        const ids = Array.from({ length: 101 }, (_, i) => `id${i}`);
        const result = await ob11ActionOf(
            createGroupFileOpActions({ richMediaApi } as never),
            "delete_group_file",
        ).handle({ group_id: 808, file_id: "f1", file_ids: ids });
        expect(result.retcode).toBe(400);
        expect(richMediaApi.deleteGroupFile).not.toHaveBeenCalled();
    });

    it("delete_group_folder → deleteGroupFolder(group, folder_id)", async () => {
        const richMediaApi = { deleteGroupFolder: vi.fn(async () => undefined) };
        const result = await ob11ActionOf(
            createGroupFileOpActions({ richMediaApi } as never),
            "delete_group_folder",
        ).handle({ group_id: 808, folder_id: "d1" });
        expect(result.retcode).toBe(0);
        expect(richMediaApi.deleteGroupFolder).toHaveBeenCalledWith("808", "d1");
    });
});

describe("rename_group_file / move_group_file / trans_group_file", () => {
    it("rename → renameGroupFile(group, file_id, new_name)", async () => {
        const richMediaApi = { renameGroupFile: vi.fn(async () => undefined) };
        const result = await ob11ActionOf(
            createGroupFileOpActions({ richMediaApi } as never),
            "rename_group_file",
        ).handle({ group_id: 808, file_id: "f1", new_name: "新名.zip" });
        expect(result.retcode).toBe(0);
        expect(richMediaApi.renameGroupFile).toHaveBeenCalledWith("808", "f1", "新名.zip");
    });

    it("move → moveGroupFile(group, ids, folder_id)；folder_id 缺省根目录空串", async () => {
        const richMediaApi = { moveGroupFile: vi.fn(async () => undefined) };
        const actions = createGroupFileOpActions({ richMediaApi } as never);
        await ob11ActionOf(actions, "move_group_file").handle({
            group_id: 808,
            file_id: "f1",
            folder_id: "d2",
        });
        expect(richMediaApi.moveGroupFile).toHaveBeenLastCalledWith("808", ["f1"], "d2");
        await ob11ActionOf(actions, "move_group_file").handle({
            group_id: 808,
            file_id: "f1",
            file_ids: ["x", "y"],
        });
        expect(richMediaApi.moveGroupFile).toHaveBeenLastCalledWith("808", ["x", "y"], "");
    });

    it("trans → transGroupFile(group, file_id)", async () => {
        const richMediaApi = { transGroupFile: vi.fn(async () => undefined) };
        const result = await ob11ActionOf(
            createGroupFileOpActions({ richMediaApi } as never),
            "trans_group_file",
        ).handle({ group_id: 808, file_id: "f9" });
        expect(result.retcode).toBe(0);
        expect(richMediaApi.transGroupFile).toHaveBeenCalledWith("808", "f9");
    });
});
