/**
 * richmedia.ts RichMediaApi 扩展测试（p2-batch2 基线之外的方法面）：
 *  - translateWords / getGroupFileList（形状 + parentFolderId 过滤）/
 *    getGroupFileSystemInfo / createGroupFolder / deleteGroupFile / deleteGroupFolder /
 *    renameGroupFile / moveGroupFile / transGroupFile
 *  - extractFileList 宽松形状（数组 / items / fileList / list / 缺失）
 */
import { describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import { extractFileList, RichMediaApi } from "../richmedia.js";
import { makeSession } from "./test-support.js";

function makeApi(overrides: Record<string, unknown> = {}) {
    const service = {
        translateEnWordToZn: vi.fn(async () => ({ result: 0, errMsg: "", words: ["你好"] })),
        getGroupFileList: vi.fn(async () => ({
            result: 0,
            errMsg: "",
            groupSpaceResult: { usedSpace: 100, totalSpace: 1000 },
        })),
        createGroupFolder: vi.fn(async () => ({ result: 0, errMsg: "" })),
        deleteGroupFile: vi.fn(async () => ({ result: 0, errMsg: "" })),
        deleteGroupFolder: vi.fn(async () => ({ result: 0, errMsg: "" })),
        renameGroupFile: vi.fn(async () => null),
        moveGroupFile: vi.fn(async () => ({ result: 0, errMsg: "" })),
        transGroupFile: vi.fn(async () => ({ result: 0, errMsg: "" })),
        ...overrides,
    };
    const api = new RichMediaApi(makeSession({ getRichMediaService: () => service }));
    return { api, service };
}

describe("constructor", () => {
    it("getRichMediaService 空 / undefined → INVALID_STATE", () => {
        expect(() => new RichMediaApi(makeSession({ getRichMediaService: () => null }))).toThrow(
            /getRichMediaService\(\) 返回空/,
        );
        expect(
            () => new RichMediaApi(makeSession({ getRichMediaService: () => undefined })),
        ).toThrow(/getRichMediaService\(\) 返回空/);
    });
});

describe("translateWords", () => {
    it("成功返回 words；words 缺失 → 空数组", async () => {
        const { api } = makeApi();
        await expect(api.translateWords(["hello"])).resolves.toEqual(["你好"]);
        const { api: api2 } = makeApi({
            translateEnWordToZn: vi.fn(async () => ({ result: 0, errMsg: "" })),
        });
        await expect(api2.translateWords(["hello"])).resolves.toEqual([]);
    });

    it("result 非 0 抛错", async () => {
        const { api } = makeApi({
            translateEnWordToZn: vi.fn(async () => ({ result: 1, errMsg: "x" })),
        });
        await expect(api.translateWords(["hello"])).rejects.toMatchObject({
            message: /translateEnWordToZn 失败/,
        });
    });
});

describe("getGroupFileList", () => {
    it("result 即列表形状：返回全部条目（根目录）", async () => {
        const items = [{ fileInfo: { fileId: "f1" } }, { folderInfo: { folderUid: "d1" } }];
        const { api } = makeApi({
            getGroupFileList: vi.fn(async () => ({ result: items, errMsg: "" })),
        });
        await expect(api.getGroupFileList("10001")).resolves.toEqual(items);
    });

    it("result=0 且 raw 顶层列表形状兜底提取", async () => {
        const items = [{ fileInfo: { fileId: "f1" } }];
        const { api } = makeApi({
            getGroupFileList: vi.fn(async () => ({ result: 0, errMsg: "", ...{ items } })),
        });
        await expect(api.getGroupFileList("10001")).resolves.toEqual(items);
    });

    it("parentFolderId 过滤：fileInfo.parent / folderInfo.folderUid 匹配", async () => {
        const items = [
            { fileInfo: { fileId: "f1", parent: "d1" } },
            { fileInfo: { fileId: "f2", parent: "d2" } },
            { folderInfo: { folderUid: "d1" } },
            { folderInfo: { folderUid: "d3" } },
        ];
        const { api } = makeApi({
            getGroupFileList: vi.fn(async () => ({ result: items, errMsg: "" })),
        });
        await expect(api.getGroupFileList("10001", "d1")).resolves.toEqual([
            { fileInfo: { fileId: "f1", parent: "d1" } },
            { folderInfo: { folderUid: "d1" } },
        ]);
    });

    it("宽松 result 数字非 0 抛错；fileCount 参数透传", async () => {
        const { api } = makeApi({
            getGroupFileList: vi.fn(async () => ({ result: 3, errMsg: "x" })),
        });
        await expect(api.getGroupFileList("10001")).rejects.toBeInstanceOf(KernelError);
        const { api: api2, service: service2 } = makeApi({
            getGroupFileList: vi.fn(async () => ({ result: [], errMsg: "" })),
        });
        await api2.getGroupFileList("10001", "", 10);
        expect(service2.getGroupFileList).toHaveBeenCalledWith(
            "10001",
            expect.objectContaining({ fileCount: 10 }),
        );
    });
});

describe("getGroupFileSystemInfo", () => {
    it("result=0 时提取 groupSpaceResult（fileCount 走 countGroupFiles）", async () => {
        const { api } = makeApi({
            getGroupFileList: vi.fn(async () => ({
                result: 0,
                errMsg: "",
                groupSpaceResult: { usedSpace: 2048, totalSpace: 4096 },
            })),
        });
        await expect(api.getGroupFileSystemInfo("10001")).resolves.toEqual({
            fileCount: 0,
            limitCount: 0,
            usedSpace: 2048,
            totalSpace: 4096,
        });
    });

    it("groupSpaceResult 缺失抛 UNKNOWN", async () => {
        const { api } = makeApi({
            getGroupFileList: vi.fn(async () => ({ result: 0, errMsg: "" })),
        });
        await expect(api.getGroupFileSystemInfo("10001")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /无 groupSpaceResult/,
        });
    });

    it("result 为列表形状（非 0 数字语义）被严格 unwrap 拒绝（疑似 bug：fileCount 恒 0）", async () => {
        // 现状：result 即列表（getGroupFileList 宽松形状）时 result !== 0 → unwrap 抛错，
        // 导致 getGroupFileSystemInfo 在真实返回形状下不可用（countGroupFiles 永远收不到数组）。
        // 本用例锁定现状行为，修复后应改为断言 fileCount 计数。
        const { api } = makeApi({
            getGroupFileList: vi.fn(async () => ({
                result: [{ fileInfo: { fileId: "f1" } }],
                errMsg: "",
                groupSpaceResult: { usedSpace: 1, totalSpace: 2 },
            })),
        });
        await expect(api.getGroupFileSystemInfo("10001")).rejects.toMatchObject({
            message: /getGroupFileList 失败/,
        });
    });
});

describe("文件夹与文件操作", () => {
    it("createGroupFolder：result=0 返回空串（待校准兜底）；失败抛错", async () => {
        const { api } = makeApi({
            createGroupFolder: vi.fn(async () => ({ result: 0, errMsg: "" })),
        });
        await expect(api.createGroupFolder("10001", "新建夹")).resolves.toBe("");
        const { api: api3 } = makeApi({
            createGroupFolder: vi.fn(async () => ({ result: 1, errMsg: "x" })),
        });
        await expect(api3.createGroupFolder("10001", "新建夹")).rejects.toBeInstanceOf(KernelError);
    });

    it("createGroupFolder：result 字符串形状被严格 unwrap 拒绝（疑似 bug：folderId 提取分支不可达）", async () => {
        // 现状：result 为 folderId 字符串时 result !== 0 → unwrap 抛错，
        // `typeof result === "string"` 返回分支实际不可达。锁定现状，修复后调整断言。
        const { api } = makeApi({
            createGroupFolder: vi.fn(async () => ({ result: "fd-1", errMsg: "" })),
        });
        await expect(api.createGroupFolder("10001", "新建夹")).rejects.toMatchObject({
            message: /createGroupFolder 失败/,
        });
    });

    it("deleteGroupFile / deleteGroupFolder / transGroupFile：失败抛错", async () => {
        const { api, service } = makeApi();
        await api.deleteGroupFile("10001", ["f1", "f2"]);
        expect(service.deleteGroupFile).toHaveBeenCalledWith("10001", [102], ["f1", "f2"]);
        await api.deleteGroupFolder("10001", "d1");
        expect(service.deleteGroupFolder).toHaveBeenCalledWith("10001", "d1");
        await api.transGroupFile("10001", "f1");
        expect(service.transGroupFile).toHaveBeenCalledWith("10001", "f1");
        const { api: api2 } = makeApi({
            deleteGroupFile: vi.fn(async () => ({ result: 4, errMsg: "x" })),
        });
        await expect(api2.deleteGroupFile("10001", ["f1"])).rejects.toBeInstanceOf(KernelError);
    });

    it("renameGroupFile：五参形态（bizType=102）；moveGroupFile 参数组装", async () => {
        const { api, service } = makeApi();
        await api.renameGroupFile("10001", "f1", "新名");
        expect(service.renameGroupFile).toHaveBeenCalledWith("10001", 102, "f1", "新名", "");
        await api.moveGroupFile("10001", ["f1"], "d2");
        expect(service.moveGroupFile).toHaveBeenCalledWith("10001", [102], ["f1"], "", "d2");
        const { api: api2 } = makeApi({
            moveGroupFile: vi.fn(async () => ({ result: 6, errMsg: "x" })),
        });
        await expect(api2.moveGroupFile("10001", ["f1"], "d2")).rejects.toBeInstanceOf(KernelError);
    });
});

describe("extractFileList 宽松形状", () => {
    it("数组 / items / fileList / list 键 / 缺失", () => {
        const arr = [{ fileInfo: {} }];
        expect(extractFileList(arr)).toBe(arr);
        expect(extractFileList({ items: arr })).toBe(arr);
        expect(extractFileList({ fileList: arr })).toBe(arr);
        expect(extractFileList({ list: arr })).toBe(arr);
        expect(extractFileList({ noKey: 1 })).toEqual([]);
        expect(extractFileList("str")).toEqual([]);
        expect(extractFileList(null)).toEqual([]);
    });
});

describe("错误路径与返回形状补充", () => {
    it("createGroupFolder：result 为 0 且非字符串 → 空串占位（folderId 形状待探测）", async () => {
        const { api } = makeApi({
            createGroupFolder: vi.fn(async () => ({ result: 0, errMsg: "" })),
        });
        await expect(api.createGroupFolder("10001", "新文件夹")).resolves.toBe("");
    });

    it("createGroupFolder：result 非 0 抛错", async () => {
        const { api } = makeApi({
            createGroupFolder: vi.fn(async () => ({ result: 8, errMsg: "no space" })),
        });
        await expect(api.createGroupFolder("10001", "新文件夹")).rejects.toMatchObject({
            code: "UNKNOWN",
            message: /createGroupFolder 失败: no space/,
        });
    });

    it("deleteGroupFile / deleteGroupFolder：result 非 0 抛错", async () => {
        const { api } = makeApi({
            deleteGroupFile: vi.fn(async () => ({ result: 2, errMsg: "file busy" })),
            deleteGroupFolder: vi.fn(async () => ({ result: 3, errMsg: "folder busy" })),
        });
        await expect(api.deleteGroupFile("10001", ["f1"])).rejects.toMatchObject({
            message: /deleteGroupFile 失败: file busy/,
        });
        await expect(api.deleteGroupFolder("10001", "fd1")).rejects.toMatchObject({
            message: /deleteGroupFolder 失败: folder busy/,
        });
    });

    it("transGroupFile：result 非 0 抛错", async () => {
        const { api } = makeApi({
            transGroupFile: vi.fn(async () => ({ result: 6, errMsg: "trans denied" })),
        });
        await expect(api.transGroupFile("10001", "f1")).rejects.toMatchObject({
            message: /transGroupFile 失败: trans denied/,
        });
    });

    it("moveGroupFile：result 非 0 抛错", async () => {
        const { api } = makeApi({
            moveGroupFile: vi.fn(async () => ({ result: 4, errMsg: "move denied" })),
        });
        await expect(api.moveGroupFile("10001", ["f1"], "fd2")).rejects.toMatchObject({
            message: /moveGroupFile 失败: move denied/,
        });
    });

    it("getGroupFileList：result 为数组形态 → 原样作为文件列表返回", async () => {
        const { api } = makeApi({
            getGroupFileList: vi.fn(async () => ({
                result: [{ fileInfo: { fileId: "1" } }, { fileInfo: { fileId: "2" } }, {}],
                groupSpaceResult: { usedSpace: 1, totalSpace: 2 },
            })),
        });
        const items = await api.getGroupFileList("10001");
        expect(items).toHaveLength(3);
        expect(items[0]?.fileInfo).toEqual({ fileId: "1" });
        // 顶层列表形态兜底（extractFileList(raw)）同路径
        const { api: api2 } = makeApi({
            getGroupFileList: vi.fn(async () => [{ fileInfo: { fileId: "top" } }]),
        });
        await expect(api2.getGroupFileList("10001")).resolves.toEqual([
            { fileInfo: { fileId: "top" } },
        ]);
    });

    it("getGroupFileDownloadUrl：命中且 url 空 → NOT_FOUND（无链接）", async () => {
        const { api } = makeApi({
            getGroupFileList: vi.fn(async () => ({
                result: { items: [{ fileInfo: { fileId: "f1", url: "" } }] },
                groupSpaceResult: { usedSpace: 0, totalSpace: 0 },
            })),
        });
        await expect(api.getGroupFileDownloadUrl("10001", "f1")).rejects.toMatchObject({
            code: "NOT_FOUND",
            message: /无下载链接/,
        });
    });
});
