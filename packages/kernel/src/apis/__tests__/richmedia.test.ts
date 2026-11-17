/**
 * richmedia.ts extractFileList 基线测试（fallow 重构目标，untested risk）
 *
 * 覆盖 getGroupFileList 返回形状提取：
 *  - 数组直接提取（逐项过 isGroupFileListItem）
 *  - { items } / { item } / { fileList } / { list } 兼容
 *  - null / 非对象 / 无匹配键 → 空数组
 *  - 残缺项（fileInfo 缺 fileName / folderInfo 缺 folderName）逐项丢弃
 */
import { describe, expect, it } from "vitest";
import { extractFileList, type GroupFileListItem } from "../richmedia.js";

const file: GroupFileListItem = {
    fileInfo: { fileId: "1", fileName: "a.txt", fileSize: "1" },
};
const folder: GroupFileListItem = {
    folderInfo: { folderId: "d1", folderName: "文档", folderUid: "f1" },
};

describe("extractFileList", () => {
    it("数组直接返回", () => {
        expect(extractFileList([file, folder])).toEqual([file, folder]);
    });

    it("{ items } 提取", () => {
        expect(extractFileList({ items: [file] })).toEqual([file]);
    });

    it("{ item } 提取（探测期形状）", () => {
        expect(extractFileList({ item: [file] })).toEqual([file]);
    });

    it("{ fileList } 提取", () => {
        expect(extractFileList({ fileList: [folder] })).toEqual([folder]);
    });

    it("{ list } 提取", () => {
        expect(extractFileList({ list: [file] })).toEqual([file]);
    });

    it("null 返回空数组", () => {
        expect(extractFileList(null)).toEqual([]);
    });

    it("非对象（字符串）返回空数组", () => {
        expect(extractFileList("x")).toEqual([]);
    });

    it("对象无匹配键返回空数组", () => {
        expect(extractFileList({ other: [file] })).toEqual([]);
    });

    it("items 非数组返回空数组", () => {
        expect(extractFileList({ items: "not-array" })).toEqual([]);
    });

    it("残缺项逐项丢弃（不整数组强转）", () => {
        const items = [
            { fileInfo: { fileId: "1" } }, // 缺 fileName
            { folderInfo: { folderUid: "d1" } }, // 缺 folderId/folderName
            null,
            "junk",
            file,
            {}, // 两者皆无 → 合法空条目（GroupFileListItem 两字段均可选）
        ];
        expect(extractFileList(items)).toEqual([file, {}]);
    });
});
