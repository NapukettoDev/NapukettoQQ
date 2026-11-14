/**
 * Milky 群文件类动作：get_group_files / move / rename / delete /
 * persist_group_file / create_group_folder / delete_group_folder /
 * upload_group_file / get_group_file_download_url / rename_group_folder。
 *
 * 群文件管理/查询走 RichMediaApi（群文件系列）；**upload_group_file 走闪传**
 * （kernel FlashTransferApi：上传文件集 + 发分享卡片）。
 * 已知语义降级：①发出去的是「分享链接卡片」，不是群文件条目、也不进群文件列表；
 * ②返回的 file_id 是闪传文件集 id，只能自己留存，不能喂给 get_group_file_download_url /
 * delete_group_file 等群文件动作；③parent_folder_id 不参与定位（闪传没有目录概念）。
 * 之所以不用消息发送链：`sendMsg` 带 fileElement 时原生会走文件传输命令，该命令被服务端
 * 拒绝（170019002，扫参无效），fileUuid 永远拿不到（kernel design §15.3/§15.4）。
 * download_url 仅根目录可达。
 * 实体字段以 GroupFileItemInfo / GroupFolderInfo 为源；下载次数 / 过期时间 /
 * 文件夹元数据等无源字段 0/null 兜底（待探测校准）。
 */
import type { GroupFileItemInfo, GroupFolderInfo, Peer } from "@napuketto/kernel";
import { ChatType } from "@napuketto/kernel";
import { z } from "zod";
import type { MilkyApi } from "../api.js";
import { resolveUriToPath } from "../helper/message/media-uri.js";
import type {
    CreateGroupFolderOutput,
    GetFileDownloadUrlOutput,
    GetGroupFilesOutput,
    GroupFileEntity,
    GroupFolderEntity,
    UploadFileOutput,
} from "../types.js";
import { defineMilkyAction, type MilkyAction } from "./base-action.js";
import { groupIdField } from "./group-query.js";

const fileIdField = { file_id: z.string().min(1) } as const;
const optStr = z.string().nullable().optional();

/** 群文件域动作工厂（列表 / 移动 / 重命名 / 删除 / 转存 / 文件夹 / 闪传上传 / 下载链接）。 */
export function createGroupFileActions(api: MilkyApi): MilkyAction[] {
    return [
        defineMilkyAction({
            name: "get_group_files",
            schema: z.object({ ...groupIdField, parent_folder_id: optStr }),
            // 根目录或指定文件夹；过滤 parent 匹配项
            handle: async (payload: {
                group_id: number;
                parent_folder_id?: string | null | undefined;
            }): Promise<GetGroupFilesOutput> => {
                const groupCode = String(payload.group_id);
                const parent = payload.parent_folder_id ?? "";
                const items = await api.richMediaApi.getGroupFileList(groupCode, parent);
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
            },
        }),
        defineMilkyAction({
            name: "move_group_file",
            schema: z.object({
                ...groupIdField,
                ...fileIdField,
                parent_folder_id: optStr,
                target_folder_id: optStr,
            }),
            // target_folder_id 空 = 移到根目录；parent 入参仅 schema 兼容
            handle: async (payload: {
                group_id: number;
                file_id: string;
                parent_folder_id?: string | null | undefined;
                target_folder_id?: string | null | undefined;
            }) => {
                await api.richMediaApi.moveGroupFile(
                    String(payload.group_id),
                    [payload.file_id],
                    payload.target_folder_id ?? "",
                );
                return {};
            },
        }),
        defineMilkyAction({
            name: "rename_group_file",
            schema: z.object({
                ...groupIdField,
                ...fileIdField,
                parent_folder_id: optStr,
                new_file_name: z.string().min(1),
            }),
            handle: async (payload: {
                group_id: number;
                file_id: string;
                parent_folder_id?: string | null | undefined;
                new_file_name: string;
            }) => {
                await api.richMediaApi.renameGroupFile(
                    String(payload.group_id),
                    payload.file_id,
                    payload.new_file_name,
                );
                return {};
            },
        }),
        defineMilkyAction({
            name: "delete_group_file",
            schema: z.object({ ...groupIdField, ...fileIdField }),
            handle: async (payload: { group_id: number; file_id: string }) => {
                await api.richMediaApi.deleteGroupFile(String(payload.group_id), [payload.file_id]);
                return {};
            },
        }),
        defineMilkyAction({
            name: "persist_group_file",
            schema: z.object({ ...groupIdField, ...fileIdField }),
            // RichMediaApi.transGroupFile，转存语义待对齐
            handle: async (payload: { group_id: number; file_id: string }) => {
                await api.richMediaApi.transGroupFile(String(payload.group_id), payload.file_id);
                return {};
            },
        }),
        defineMilkyAction({
            name: "create_group_folder",
            schema: z.object({ ...groupIdField, folder_name: z.string().min(1) }),
            handle: async (payload: {
                group_id: number;
                folder_name: string;
            }): Promise<CreateGroupFolderOutput> => {
                const folderId = await api.richMediaApi.createGroupFolder(
                    String(payload.group_id),
                    payload.folder_name,
                );
                return { folder_id: folderId };
            },
        }),
        defineMilkyAction({
            name: "delete_group_folder",
            schema: z.object({ ...groupIdField, folder_id: z.string().min(1) }),
            handle: async (payload: { group_id: number; folder_id: string }) => {
                await api.richMediaApi.deleteGroupFolder(
                    String(payload.group_id),
                    payload.folder_id,
                );
                return {};
            },
        }),
        defineMilkyAction({
            name: "upload_group_file",
            schema: z.object({
                ...groupIdField,
                parent_folder_id: optStr,
                file_uri: z.string().min(1),
                file_name: z.string().min(1),
            }),
            // 闪传通道：上传文件集 + 发卡片（卡片即投递结果，不产生群文件条目；
            // file_id 返回闪传文件集 id，非群文件 fileId）
            handle: async (payload: {
                group_id: number;
                parent_folder_id?: string | null | undefined;
                file_uri: string;
                file_name: string;
            }): Promise<UploadFileOutput> => {
                const path = await resolveUriToPath(payload.file_uri, api.mediaDir);
                const peer: Peer = { chatType: ChatType.GROUP, peerUid: String(payload.group_id) };
                const uploaded = await api.flashTransferApi.sendFile(peer, [path], {
                    name: payload.file_name,
                });
                return { file_id: uploaded.fileSetId };
            },
        }),
        defineMilkyAction({
            name: "get_group_file_download_url",
            schema: z.object({ ...groupIdField, ...fileIdField }),
            // url 字段待实机确认，仅根目录
            handle: async (payload: {
                group_id: number;
                file_id: string;
            }): Promise<GetFileDownloadUrlOutput> => {
                const url = await api.richMediaApi.getGroupFileDownloadUrl(
                    String(payload.group_id),
                    payload.file_id,
                );
                return { download_url: url };
            },
        }),
        defineMilkyAction({
            name: "rename_group_folder",
            schema: z.object({
                ...groupIdField,
                folder_id: z.string().min(1),
                new_folder_name: z.string().min(1),
            }),
            // renameGroupFile 同款形态，待校准
            handle: async (payload: {
                group_id: number;
                folder_id: string;
                new_folder_name: string;
            }) => {
                await api.richMediaApi.renameGroupFolder(
                    String(payload.group_id),
                    payload.folder_id,
                    payload.new_folder_name,
                );
                return {};
            },
        }),
    ];
}

/** ---------- 内部辅助 ---------- */

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
