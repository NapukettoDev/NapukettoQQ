/**
 * 群文件操作动作（P2-14）：create_group_file_folder / delete_group_file /
 * delete_group_folder / rename_group_file / move_group_file / trans_group_file
 */
import type { RichMediaApi } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { MAX_FILE_IDS } from "../limits.js";

const createGroupFileFolderSchema = z.object({
    group_id: z.number(),
    folder_name: z.string(),
});

type CreateGroupFileFolderPayload = z.infer<typeof createGroupFileFolderSchema>;

/** 创建群文件夹（P2-14）。 */
export class CreateGroupFileFolderAction extends BaseAction<
    CreateGroupFileFolderPayload,
    { folder_id: string }
> {
    readonly name = "create_group_file_folder";
    readonly schema = createGroupFileFolderSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: CreateGroupFileFolderPayload): Promise<{ folder_id: string }> {
        const folderId = await this.richMediaApi.createGroupFolder(
            String(payload.group_id),
            payload.folder_name,
        );
        return { folder_id: folderId };
    }
}

const deleteGroupFileSchema = z.object({
    group_id: z.number(),
    file_id: z.string(),
    /** 兼容 go-cqhttp 的 file_ids 数组（取第一个）。 */
    file_ids: z.array(z.string()).max(MAX_FILE_IDS).optional(),
});

type DeleteGroupFilePayload = z.infer<typeof deleteGroupFileSchema>;

/** 删除群文件（P2-14）。 */
export class DeleteGroupFileAction extends BaseAction<DeleteGroupFilePayload, null> {
    readonly name = "delete_group_file";
    readonly schema = deleteGroupFileSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: DeleteGroupFilePayload): Promise<null> {
        const ids = payload.file_ids ?? [payload.file_id];
        await this.richMediaApi.deleteGroupFile(String(payload.group_id), ids);
        return null;
    }
}

const deleteGroupFolderSchema = z.object({
    group_id: z.number(),
    folder_id: z.string(),
});

type DeleteGroupFolderPayload = z.infer<typeof deleteGroupFolderSchema>;

/** 删除群文件夹（P2-14）。 */
export class DeleteGroupFolderAction extends BaseAction<DeleteGroupFolderPayload, null> {
    readonly name = "delete_group_folder";
    readonly schema = deleteGroupFolderSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: DeleteGroupFolderPayload): Promise<null> {
        await this.richMediaApi.deleteGroupFolder(String(payload.group_id), payload.folder_id);
        return null;
    }
}

const renameGroupFileSchema = z.object({
    group_id: z.number(),
    file_id: z.string(),
    new_name: z.string(),
});

type RenameGroupFilePayload = z.infer<typeof renameGroupFileSchema>;

/** 重命名群文件（P2-14）。 */
export class RenameGroupFileAction extends BaseAction<RenameGroupFilePayload, null> {
    readonly name = "rename_group_file";
    readonly schema = renameGroupFileSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: RenameGroupFilePayload): Promise<null> {
        await this.richMediaApi.renameGroupFile(
            String(payload.group_id),
            payload.file_id,
            payload.new_name,
        );
        return null;
    }
}

const moveGroupFileSchema = z.object({
    group_id: z.number(),
    file_id: z.string(),
    file_ids: z.array(z.string()).max(MAX_FILE_IDS).optional(),
    /** 目标文件夹 ID（空为根目录）。 */
    folder_id: z.string().optional(),
});

type MoveGroupFilePayload = z.infer<typeof moveGroupFileSchema>;

/** 移动群文件（P2-14）。 */
export class MoveGroupFileAction extends BaseAction<MoveGroupFilePayload, null> {
    readonly name = "move_group_file";
    readonly schema = moveGroupFileSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: MoveGroupFilePayload): Promise<null> {
        const ids = payload.file_ids ?? [payload.file_id];
        await this.richMediaApi.moveGroupFile(
            String(payload.group_id),
            ids,
            payload.folder_id ?? "",
        );
        return null;
    }
}

const transGroupFileSchema = z.object({
    group_id: z.number(),
    file_id: z.string(),
});

type TransGroupFilePayload = z.infer<typeof transGroupFileSchema>;

/** 转存群文件（P2-14）。 */
export class TransGroupFileAction extends BaseAction<TransGroupFilePayload, null> {
    readonly name = "trans_group_file";
    readonly schema = transGroupFileSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: TransGroupFilePayload): Promise<null> {
        await this.richMediaApi.transGroupFile(String(payload.group_id), payload.file_id);
        return null;
    }
}
