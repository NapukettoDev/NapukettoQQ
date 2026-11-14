/**
 * 群文件操作动作：create_group_file_folder / delete_group_file /
 * delete_group_folder / rename_group_file / move_group_file / trans_group_file
 */
import { z } from "zod";
import type { OneBotApi } from "../../api/one-bot-api.js";
import { defineOb11Action, type Ob11Action } from "../base-action.js";
import { MAX_FILE_IDS } from "../limits.js";

/** 群文件操作域动作工厂（create/delete folder、delete/rename/move/trans file）。 */
export function createGroupFileOpActions(api: OneBotApi): Ob11Action[] {
    return [
        defineOb11Action({
            name: "create_group_file_folder",
            schema: z.object({
                group_id: z.number(),
                folder_name: z.string(),
            }),
            handle: async (payload) => {
                const folderId = await api.richMediaApi.createGroupFolder(
                    String(payload.group_id),
                    payload.folder_name,
                );
                return { folder_id: folderId };
            },
        }),
        defineOb11Action({
            name: "delete_group_file",
            schema: z.object({
                group_id: z.number(),
                file_id: z.string(),
                /** 兼容 go-cqhttp 的 file_ids 数组（取第一个）。 */
                file_ids: z.array(z.string()).max(MAX_FILE_IDS).optional(),
            }),
            handle: async (payload) => {
                const ids = payload.file_ids ?? [payload.file_id];
                await api.richMediaApi.deleteGroupFile(String(payload.group_id), ids);
                return null;
            },
        }),
        defineOb11Action({
            name: "delete_group_folder",
            schema: z.object({
                group_id: z.number(),
                folder_id: z.string(),
            }),
            handle: async (payload) => {
                await api.richMediaApi.deleteGroupFolder(
                    String(payload.group_id),
                    payload.folder_id,
                );
                return null;
            },
        }),
        defineOb11Action({
            name: "rename_group_file",
            schema: z.object({
                group_id: z.number(),
                file_id: z.string(),
                new_name: z.string(),
            }),
            handle: async (payload) => {
                await api.richMediaApi.renameGroupFile(
                    String(payload.group_id),
                    payload.file_id,
                    payload.new_name,
                );
                return null;
            },
        }),
        defineOb11Action({
            name: "move_group_file",
            schema: z.object({
                group_id: z.number(),
                file_id: z.string(),
                file_ids: z.array(z.string()).max(MAX_FILE_IDS).optional(),
                /** 目标文件夹 ID（空为根目录）。 */
                folder_id: z.string().optional(),
            }),
            handle: async (payload) => {
                const ids = payload.file_ids ?? [payload.file_id];
                await api.richMediaApi.moveGroupFile(
                    String(payload.group_id),
                    ids,
                    payload.folder_id ?? "",
                );
                return null;
            },
        }),
        defineOb11Action({
            name: "trans_group_file",
            schema: z.object({
                group_id: z.number(),
                file_id: z.string(),
            }),
            handle: async (payload) => {
                await api.richMediaApi.transGroupFile(String(payload.group_id), payload.file_id);
                return null;
            },
        }),
    ];
}
