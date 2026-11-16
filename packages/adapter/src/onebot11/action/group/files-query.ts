/**
 * 群文件查询动作：get_group_root_files / get_group_files_by_folder /
 * get_group_file_system_info
 */
import type { GroupFileItemInfo, GroupFolderInfo } from "@napuketto/kernel";
import { z } from "zod";
import type { OneBotApi } from "../../api/onebot-api.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";

/** 默认文件数量。 */
const DEFAULT_FILE_COUNT = 50;

/** 文件条目 OB11 结构（命名加 `Ob11` 前缀避免与协议事件 / kernel 类型同名异构）。 */
interface Ob11GroupFileEntry {
    file_id: string;
    file_name: string;
    file_size: string;
    uploader?: number;
    upload_time?: number;
    modify_time?: number;
}

/** 文件夹条目 OB11 结构（同上）。 */
interface Ob11GroupFolderEntry {
    folder_id: string;
    folder_name: string;
}

/** 群文件列表返回。 */
interface GroupFilesResult {
    files: Ob11GroupFileEntry[];
    folders: Ob11GroupFolderEntry[];
}

/** 列表拆分 files/folders（fileInfo/folderInfo 取其一，纯函数）。 */
function splitFilesAndFolders(
    list: Array<{ fileInfo?: GroupFileItemInfo; folderInfo?: GroupFolderInfo }>,
): GroupFilesResult {
    const files: Ob11GroupFileEntry[] = [];
    const folders: Ob11GroupFolderEntry[] = [];
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
function toGroupFileInfo(file: GroupFileItemInfo): Ob11GroupFileEntry {
    const out: Ob11GroupFileEntry = {
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

/** GroupFolderInfo → OB11 文件夹结构（纯函数）。 */
function toGroupFolderInfo(folder: GroupFolderInfo): Ob11GroupFolderEntry {
    return {
        folder_id: folder.folderId,
        folder_name: folder.folderName,
    };
}

/** 群文件查询域动作工厂（root files / by folder / system info）。 */
export function createGroupFileQueryActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "get_group_root_files",
            schema: z.object({
                group_id: z.number(),
                file_count: z.number().optional(),
            }),
            handle: async (payload): Promise<GroupFilesResult> => {
                const list = await api.richMediaApi.getGroupFileList(
                    String(payload.group_id),
                    "",
                    payload.file_count ?? DEFAULT_FILE_COUNT,
                );
                return splitFilesAndFolders(list);
            },
        }),
        defineOb11Action({
            name: "get_group_files_by_folder",
            schema: z.object({
                group_id: z.number(),
                folder_id: z.string(),
                file_count: z.number().optional(),
            }),
            handle: async (payload): Promise<GroupFilesResult> => {
                const list = await api.richMediaApi.getGroupFileList(
                    String(payload.group_id),
                    payload.folder_id,
                    payload.file_count ?? DEFAULT_FILE_COUNT,
                );
                return splitFilesAndFolders(list);
            },
        }),
        defineOb11Action({
            name: "get_group_file_system_info",
            schema: z.object({ group_id: z.number() }),
            handle: async (
                payload,
            ): Promise<{
                file_count: number;
                limit_count: number;
                used_space: number;
                total_space: number;
            }> => {
                const info = await api.richMediaApi.getGroupFileSystemInfo(
                    String(payload.group_id),
                );
                return {
                    file_count: info.fileCount,
                    limit_count: info.limitCount,
                    used_space: info.usedSpace,
                    total_space: info.totalSpace,
                };
            },
        }),
    ];
}
