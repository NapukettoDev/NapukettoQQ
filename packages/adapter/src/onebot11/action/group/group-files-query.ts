/**
 * 群文件查询动作（P2-14）：get_group_root_files / get_group_files_by_folder /
 * get_group_file_system_info
 */
import type {
    GroupFileItemInfo,
    GroupFolderInfo as KernelFolderInfo,
    RichMediaApi,
} from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { ob11ErrorCodeMap } from "../error-map.js";

const getGroupRootFilesSchema = z.object({
    group_id: z.number(),
    file_count: z.number().optional(),
});

type GetGroupRootFilesPayload = z.infer<typeof getGroupRootFilesSchema>;

/** 默认文件数量。 */
const DEFAULT_FILE_COUNT = 50;

/** 文件条目 OB11 结构。 */
export interface GroupFileInfo {
    file_id: string;
    file_name: string;
    file_size: string;
    uploader?: number;
    upload_time?: number;
    modify_time?: number;
}

/** 文件夹条目 OB11 结构。 */
export interface GroupFolderInfo {
    folder_id: string;
    folder_name: string;
}

/** 群文件列表返回。 */
export interface GroupFilesResult {
    files: GroupFileInfo[];
    folders: GroupFolderInfo[];
}

/** 获取群根目录文件列表（P2-14 接 kernel RichMediaApi）。 */
export class GetGroupRootFilesAction extends BaseAction<
    GetGroupRootFilesPayload,
    GroupFilesResult
> {
    readonly name = "get_group_root_files";
    readonly schema = getGroupRootFilesSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: GetGroupRootFilesPayload): Promise<GroupFilesResult> {
        const list = await this.richMediaApi.getGroupFileList(
            String(payload.group_id),
            "",
            payload.file_count ?? DEFAULT_FILE_COUNT,
        );
        return splitFilesAndFolders(list);
    }
}

const getGroupFilesByFolderSchema = z.object({
    group_id: z.number(),
    folder_id: z.string(),
    file_count: z.number().optional(),
});

type GetGroupFilesByFolderPayload = z.infer<typeof getGroupFilesByFolderSchema>;

/** 获取群指定文件夹文件列表（P2-14）。 */
export class GetGroupFilesByFolderAction extends BaseAction<
    GetGroupFilesByFolderPayload,
    GroupFilesResult
> {
    readonly name = "get_group_files_by_folder";
    readonly schema = getGroupFilesByFolderSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: GetGroupFilesByFolderPayload): Promise<GroupFilesResult> {
        const list = await this.richMediaApi.getGroupFileList(
            String(payload.group_id),
            payload.folder_id,
            payload.file_count ?? DEFAULT_FILE_COUNT,
        );
        return splitFilesAndFolders(list);
    }
}

const getGroupFileSystemInfoSchema = z.object({
    group_id: z.number(),
});

type GetGroupFileSystemInfoPayload = z.infer<typeof getGroupFileSystemInfoSchema>;

/** 群文件系统信息（P2-14）。 */
export class GetGroupFileSystemInfoAction extends BaseAction<
    GetGroupFileSystemInfoPayload,
    { file_count: number; limit_count: number; used_space: number; total_space: number }
> {
    readonly name = "get_group_file_system_info";
    readonly schema = getGroupFileSystemInfoSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: GetGroupFileSystemInfoPayload): Promise<{
        file_count: number;
        limit_count: number;
        used_space: number;
        total_space: number;
    }> {
        const info = await this.richMediaApi.getGroupFileSystemInfo(String(payload.group_id));
        return {
            file_count: info.fileCount,
            limit_count: info.limitCount,
            used_space: info.usedSpace,
            total_space: info.totalSpace,
        };
    }
}

/** 列表拆分 files/folders（fileInfo/folderInfo 取其一，纯函数）。 */
function splitFilesAndFolders(
    list: Array<{ fileInfo?: GroupFileItemInfo; folderInfo?: KernelFolderInfo }>,
): GroupFilesResult {
    const files: GroupFileInfo[] = [];
    const folders: GroupFolderInfo[] = [];
    for (const item of list) {
        const file = item.fileInfo;
        if (file === undefined) {
            const folder = item.folderInfo;
            if (folder !== undefined) {
                folders.push(toGroupFolderInfo(folder));
            }
        } else {
            const out = toGroupFileInfo(file);
            files.push(out);
        }
    }
    return { files, folders };
}

/** GroupFileItemInfo → OB11 文件结构（纯函数）。 */
function toGroupFileInfo(file: GroupFileItemInfo): GroupFileInfo {
    const out: GroupFileInfo = {
        file_id: file.fileId,
        file_name: file.fileName,
        file_size: file.fileSize,
    };
    if (file.uploaderUin !== undefined) {
        out.uploader = Number(file.uploaderUin);
    }
    if (file.uploadTime !== undefined) {
        out.upload_time = file.uploadTime;
    }
    if (file.modifyTime !== undefined) {
        out.modify_time = file.modifyTime;
    }
    return out;
}

/** KernelFolderInfo → OB11 文件夹结构（纯函数）。 */
function toGroupFolderInfo(folder: KernelFolderInfo): GroupFolderInfo {
    return {
        folder_id: folder.folderId,
        folder_name: folder.folderName,
    };
}

/** 群文件查询域动作工厂（root files / by folder / system info）。 */
export function createGroupFileQueryActions(api: OneBotApi): BaseAction<unknown, unknown>[] {
    return [
        new GetGroupRootFilesAction(api.richMediaApi),
        new GetGroupFilesByFolderAction(api.richMediaApi),
        new GetGroupFileSystemInfoAction(api.richMediaApi),
    ];
}
