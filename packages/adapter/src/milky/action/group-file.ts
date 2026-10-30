/**
 * Milky 群文件类动作（P1）：get_group_files / move / rename / delete /
 * persist_group_file / create_group_folder / delete_group_folder
 *
 * 全部走 RichMediaApi（群文件系列）。rename_group_folder 与
 * get_group_file_download_url kernel 无出口（P2 探测，见 docs/protocols/milky.md）。
 * 实体字段以 GroupFileItemInfo / GroupFolderInfo 为源；下载次数 / 过期时间 /
 * 文件夹元数据等无源字段 0/null 兜底（待探测校准）。
 */
import type { GroupFileItemInfo, GroupFolderInfo } from "@napuketto/kernel";
import { z } from "zod";
import type {
    CreateGroupFolderOutput,
    GetGroupFilesOutput,
    GroupFileEntity,
    GroupFolderEntity,
} from "../types.js";
import { MilkyApiAction } from "./base-action.js";

const groupIdField = { group_id: z.number().int().min(10001) } as const;
const fileIdField = { file_id: z.string().min(1) } as const;
const optStr = z.string().nullable().optional();

/** get_group_files：获取群文件列表（根目录或指定文件夹；过滤 parent 匹配项）。 */
export class GetGroupFilesAction extends MilkyApiAction<
    { group_id: number; parent_folder_id?: string | null | undefined },
    GetGroupFilesOutput
> {
    readonly name = "get_group_files";
    readonly schema = z.object({ ...groupIdField, parent_folder_id: optStr });

    protected async _handle(payload: {
        group_id: number;
        parent_folder_id?: string | null | undefined;
    }): Promise<GetGroupFilesOutput> {
        const groupCode = String(payload.group_id);
        const parent = payload.parent_folder_id ?? "";
        const items = await this.api.richMediaApi.getGroupFileList(groupCode, parent);
        const files: GroupFileEntity[] = [];
        const folders: GroupFolderEntity[] = [];
        for (const item of items) {
            if (item.fileInfo !== undefined) {
                files.push(fileToEntity(item.fileInfo, payload.group_id));
            } else if (item.folderInfo !== undefined) {
                folders.push(folderToEntity(item.folderInfo, payload.group_id));
            }
        }
        return { files, folders };
    }
}

/** move_group_file：移动文件（target_folder_id 空 = 移到根目录；parent 入参仅 schema 兼容）。 */
export class MoveGroupFileAction extends MilkyApiAction<
    {
        group_id: number;
        file_id: string;
        parent_folder_id?: string | null | undefined;
        target_folder_id?: string | null | undefined;
    },
    Record<string, never>
> {
    readonly name = "move_group_file";
    readonly schema = z.object({
        ...groupIdField,
        ...fileIdField,
        parent_folder_id: optStr,
        target_folder_id: optStr,
    });

    protected async _handle(payload: {
        group_id: number;
        file_id: string;
        parent_folder_id?: string | null | undefined;
        target_folder_id?: string | null | undefined;
    }): Promise<Record<string, never>> {
        await this.api.richMediaApi.moveGroupFile(
            String(payload.group_id),
            [payload.file_id],
            payload.target_folder_id ?? "",
        );
        return {};
    }
}

/** rename_group_file：重命名文件。 */
export class RenameGroupFileAction extends MilkyApiAction<
    {
        group_id: number;
        file_id: string;
        parent_folder_id?: string | null | undefined;
        new_file_name: string;
    },
    Record<string, never>
> {
    readonly name = "rename_group_file";
    readonly schema = z.object({
        ...groupIdField,
        ...fileIdField,
        parent_folder_id: optStr,
        new_file_name: z.string().min(1),
    });

    protected async _handle(payload: {
        group_id: number;
        file_id: string;
        parent_folder_id?: string | null | undefined;
        new_file_name: string;
    }): Promise<Record<string, never>> {
        await this.api.richMediaApi.renameGroupFile(
            String(payload.group_id),
            payload.file_id,
            payload.new_file_name,
        );
        return {};
    }
}

/** delete_group_file：删除文件。 */
export class DeleteGroupFileAction extends MilkyApiAction<
    { group_id: number; file_id: string },
    Record<string, never>
> {
    readonly name = "delete_group_file";
    readonly schema = z.object({ ...groupIdField, ...fileIdField });

    protected async _handle(payload: {
        group_id: number;
        file_id: string;
    }): Promise<Record<string, never>> {
        await this.api.richMediaApi.deleteGroupFile(String(payload.group_id), [payload.file_id]);
        return {};
    }
}

/**
 * persist_group_file：转存文件（RichMediaApi.transGroupFile，转存语义待对齐）。
 */
export class PersistGroupFileAction extends MilkyApiAction<
    { group_id: number; file_id: string },
    Record<string, never>
> {
    readonly name = "persist_group_file";
    readonly schema = z.object({ ...groupIdField, ...fileIdField });

    protected async _handle(payload: {
        group_id: number;
        file_id: string;
    }): Promise<Record<string, never>> {
        await this.api.richMediaApi.transGroupFile(String(payload.group_id), payload.file_id);
        return {};
    }
}

/** create_group_folder：创建文件夹（返回 folder_id）。 */
export class CreateGroupFolderAction extends MilkyApiAction<
    { group_id: number; folder_name: string },
    CreateGroupFolderOutput
> {
    readonly name = "create_group_folder";
    readonly schema = z.object({ ...groupIdField, folder_name: z.string().min(1) });

    protected async _handle(payload: {
        group_id: number;
        folder_name: string;
    }): Promise<CreateGroupFolderOutput> {
        const folderId = await this.api.richMediaApi.createGroupFolder(
            String(payload.group_id),
            payload.folder_name,
        );
        return { folder_id: folderId };
    }
}

/** delete_group_folder：删除文件夹。 */
export class DeleteGroupFolderAction extends MilkyApiAction<
    { group_id: number; folder_id: string },
    Record<string, never>
> {
    readonly name = "delete_group_folder";
    readonly schema = z.object({ ...groupIdField, folder_id: z.string().min(1) });

    protected async _handle(payload: {
        group_id: number;
        folder_id: string;
    }): Promise<Record<string, never>> {
        await this.api.richMediaApi.deleteGroupFolder(String(payload.group_id), payload.folder_id);
        return {};
    }
}

/** GroupFileItemInfo → GroupFileEntity（fileSize 原生为字符串；无源字段兜底）。 */
function fileToEntity(info: GroupFileItemInfo, groupId: number): GroupFileEntity {
    return {
        group_id: groupId,
        file_id: info.fileId,
        file_name: info.fileName,
        parent_folder_id: info.parent ?? "",
        file_size: Number(info.fileSize) || 0,
        uploaded_time: Number(info.uploadTime) || 0,
        expire_time: null,
        uploader_id: Number(info.uploaderUin) || 0,
        downloaded_times: 0,
    };
}

/** GroupFolderInfo → GroupFolderEntity（元数据无类型字段防御读取，缺省 0）。 */
function folderToEntity(info: GroupFolderInfo, groupId: number): GroupFolderEntity {
    const num = (key: string): number => {
        const v = info[key];
        return typeof v === "number" ? v : Number(v) || 0;
    };
    return {
        group_id: groupId,
        folder_id: info.folderId,
        parent_folder_id: info.folderUid ?? "",
        folder_name: info.folderName,
        created_time: num("createTime"),
        last_modified_time: num("modifyTime"),
        creator_id: 0,
        file_count: num("totalFileCount"),
    };
}
