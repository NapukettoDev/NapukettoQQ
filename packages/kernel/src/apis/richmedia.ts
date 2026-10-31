/**
 * RichMediaApi：富媒体语义化 API（ADR-009 统一错误语义，P2-14）
 *
 * - translateWords：translate_en2zh
 * - 群文件：列表 / 空间 / 建夹 / 删除文件 / 删除夹 / 重命名 / 移动 / 转存
 */
import { kernelError } from "../infra/index.js";
import type {
    GetFileListParam,
    GroupFileItemInfo,
    GroupFolderInfo,
    NodeIKernelRichMediaService,
    NodeIQQNTWrapperSession,
} from "../types/index.js";
import { checkLooseResult, unwrap } from "./result.js";

/** 群文件业务类型（deleteGroupFile/moveGroupFile/renameGroupFile 用，说明书参考）。 */
const GROUP_FILE_BIZ_TYPE = 102;
/** 排序方式（按时间）。 */
const SORT_TYPE_TIME = 1;
/** 排序方向（倒序）。 */
const SORT_ORDER_DESC = 2;
/** 起始下标（根目录）。 */
const START_INDEX_ROOT = 0;
/** 不显示在线文档文件夹。 */
const HIDE_ONLINEDOC_FOLDER = 0;
/** 默认文件数量。 */
const DEFAULT_FILE_COUNT = 50;
/** 空间查询文件数量（单条即可）。 */
const SPACE_QUERY_FILE_COUNT = 1;

/** 群文件列表条目（fileInfo/folderInfo 取其一）。 */
export interface GroupFileListItem {
    fileInfo?: GroupFileItemInfo;
    folderInfo?: GroupFolderInfo;
}

/** 群文件系统信息。 */
export interface GroupFileSystemInfo {
    fileCount: number;
    limitCount: number;
    usedSpace: number;
    totalSpace: number;
}

/** 富媒体 API：从 session 拿 rich media service，包装成语义化方法。 */
export class RichMediaApi {
    private readonly service: NodeIKernelRichMediaService;

    constructor(session: NodeIQQNTWrapperSession) {
        const service =
            session.getRichMediaService() as unknown as NodeIKernelRichMediaService | null;
        if (service === null || service === undefined) {
            throw kernelError("getRichMediaService() 返回空（session 未 init）", "INVALID_STATE");
        }
        this.service = service;
    }

    /** 英文单词翻译（translate_en2zh）。 */
    async translateWords(words: string[]): Promise<string[]> {
        const raw = await this.service.translateEnWordToZn(words);
        unwrap("translateEnWordToZn", raw.result, raw.errMsg);
        return raw.words ?? [];
    }

    /** 群文件列表（get_group_root_files；parent 缺省根目录）。 */
    async getGroupFileList(
        groupCode: string,
        parentFolderId = "",
        fileCount = DEFAULT_FILE_COUNT,
    ): Promise<GroupFileListItem[]> {
        const params: GetFileListParam = {
            sortType: SORT_TYPE_TIME,
            fileCount,
            startIndex: START_INDEX_ROOT,
            sortOrder: SORT_ORDER_DESC,
            showOnlinedocFolder: HIDE_ONLINEDOC_FOLDER,
        };
        const raw = await this.service.getGroupFileList(groupCode, params);
        // 宽松解包（2026-10-31 修正）：旧逻辑 result 数字非 0 抛错 + extractFileList(0)
        // 得空——真实返回形状（result 即列表 / 顶层列表 / 嵌套 items）下要么误抛要么恒空。
        checkLooseResult("getGroupFileList", raw);
        const list = extractFileList(raw.result);
        const items = list.length > 0 ? list : extractFileList(raw);
        if (parentFolderId === "") {
            return items;
        }
        return items.filter(
            (item) =>
                (item.fileInfo !== undefined && item.fileInfo.parent === parentFolderId) ||
                (item.folderInfo !== undefined && item.folderInfo.folderUid === parentFolderId),
        );
    }

    /** 群文件系统信息（get_group_file_system_info；getGroupFileList 的 groupSpaceResult）。 */
    async getGroupFileSystemInfo(groupCode: string): Promise<GroupFileSystemInfo> {
        const params: GetFileListParam = {
            sortType: SORT_TYPE_TIME,
            fileCount: SPACE_QUERY_FILE_COUNT,
            startIndex: START_INDEX_ROOT,
            sortOrder: SORT_ORDER_DESC,
            showOnlinedocFolder: HIDE_ONLINEDOC_FOLDER,
        };
        const raw = await this.service.getGroupFileList(groupCode, params);
        if (raw.result !== 0) {
            unwrap("getGroupFileList", raw.result, raw.errMsg);
        }
        const space = raw.groupSpaceResult;
        if (space === undefined) {
            throw kernelError("getGroupFileList 无 groupSpaceResult", "UNKNOWN");
        }
        return {
            fileCount: countGroupFiles(raw.result),
            limitCount: 0,
            usedSpace: space.usedSpace,
            totalSpace: space.totalSpace,
        };
    }

    /** 创建群文件夹（create_group_file_folder）。 */
    async createGroupFolder(groupCode: string, folderName: string): Promise<string> {
        const raw = await this.service.createGroupFolder(groupCode, folderName);
        if (raw.result !== 0) {
            unwrap("createGroupFolder", raw.result, raw.errMsg);
        }
        // 返回形状待探测：兼容 folderId / resultWithGroupItem
        const { result } = raw as { result?: unknown };
        if (typeof result === "string") {
            return result;
        }
        return "";
    }

    /** 删除群文件（delete_group_file）。 */
    async deleteGroupFile(groupCode: string, fileIds: string[]): Promise<void> {
        const raw = await this.service.deleteGroupFile(groupCode, [GROUP_FILE_BIZ_TYPE], fileIds);
        if (raw.result !== 0) {
            unwrap("deleteGroupFile", raw.result, raw.errMsg);
        }
    }

    /** 删除群文件夹（delete_group_folder）。 */
    async deleteGroupFolder(groupCode: string, folderId: string): Promise<void> {
        const raw = await this.service.deleteGroupFolder(groupCode, folderId);
        if (raw.result !== 0) {
            unwrap("deleteGroupFolder", raw.result, raw.errMsg);
        }
    }

    /** 重命名群文件（rename_group_file；参数语义待探测校准）。 */
    async renameGroupFile(groupCode: string, fileId: string, newName: string): Promise<void> {
        await this.service.renameGroupFile(groupCode, GROUP_FILE_BIZ_TYPE, fileId, newName, "");
    }

    /** 移动群文件（move_group_file；targetFolder 空为根目录）。 */
    async moveGroupFile(
        groupCode: string,
        fileIds: string[],
        targetFolderId: string,
    ): Promise<void> {
        const raw = await this.service.moveGroupFile(
            groupCode,
            [GROUP_FILE_BIZ_TYPE],
            fileIds,
            "",
            targetFolderId,
        );
        if (raw.result !== 0) {
            unwrap("moveGroupFile", raw.result, raw.errMsg);
        }
    }

    /** 重命名群文件夹（rename_group_folder；形态镜像 renameGroupFile，待校准）。 */
    async renameGroupFolder(groupCode: string, folderId: string, newName: string): Promise<void> {
        await this.service.renameGroupFolder(groupCode, GROUP_FILE_BIZ_TYPE, folderId, newName, "");
    }

    /**
     * 群文件下载链接（get_group_file_download_url）：getGroupFileList 根列表按
     * fileId 查找取 url 字段（字段待实机确认）。已知差异：仅根目录可达——
     * 子目录文件需 parentFolderId 逐层定位，暂不支持。
     */
    async getGroupFileDownloadUrl(groupCode: string, fileId: string): Promise<string> {
        const items = await this.getGroupFileList(groupCode);
        for (const item of items) {
            const info = item.fileInfo;
            if (info !== undefined && info.fileId === fileId) {
                if (typeof info.url === "string" && info.url !== "") {
                    return info.url;
                }
                throw kernelError(
                    `群文件 ${fileId} 无下载链接（url 字段缺失，待实机校准）`,
                    "NOT_FOUND",
                );
            }
        }
        throw kernelError(`群文件 ${fileId} 不在根目录或不存在（仅支持根目录查找）`, "NOT_FOUND");
    }

    /** 转存群文件（trans_group_file）。 */
    async transGroupFile(groupCode: string, fileId: string): Promise<void> {
        const raw = await this.service.transGroupFile(groupCode, fileId);
        if (raw.result !== 0) {
            unwrap("transGroupFile", raw.result, raw.errMsg);
        }
    }
}

/** 从 getGroupFileList 返回提取文件列表（兼容数组 / { items } / { fileList }）。导出供单测。 */
export function extractFileList(result: unknown): GroupFileListItem[] {
    if (Array.isArray(result)) {
        return result as GroupFileListItem[];
    }
    if (result === null || typeof result !== "object") {
        return [];
    }
    const obj = result as { items?: unknown; fileList?: unknown; list?: unknown };
    for (const key of ["items", "fileList", "list"] as const) {
        const value = obj[key];
        if (Array.isArray(value)) {
            return value as GroupFileListItem[];
        }
    }
    return [];
}

/** 统计文件数量（兼容数组 / { items }）。 */
function countGroupFiles(result: unknown): number {
    if (Array.isArray(result)) {
        return (result as GroupFileListItem[]).filter((item) => item.fileInfo !== undefined).length;
    }
    return 0;
}
