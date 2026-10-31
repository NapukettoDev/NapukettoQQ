/**
 * NodeIKernelRichMediaService：富媒体服务接口面（自研描述，非移植）
 *
 * 依据：运行时反射 + wrapper 外部契约（接口签名是 QQ 的外部事实，自研描述其形状，
 * 零复制实现）。
 * （接口签名是外部系统的事实，我们自研描述其形状，零复制实现）。
 * 只收录 apis/richmedia 需要的方法；其余按需探测后补齐。
 */
import type { GeneralCallResult } from "./msg-service.js";

/** 群文件列表参数（getGroupFileList，说明书参考）。 */
export interface GetFileListParam {
    sortType: number;
    fileCount: number;
    startIndex: number;
    sortOrder: number;
    showOnlinedocFolder: number;
}

/** 群文件项（getGroupFileList 返回的 fileInfo，说明书参考，待探测校准）。 */
export interface GroupFileItemInfo {
    fileId: string;
    fileName: string;
    fileSize: string;
    fileUuid?: string;
    parent?: string;
    /** 下载链接（get_group_file_download_url 数据源，字段待实机确认）。 */
    url?: string;
    uploadTime?: number;
    modifyTime?: number;
    uploaderUid?: string;
    uploaderUin?: string;
    [key: string]: unknown;
}

/** 群文件夹项（getGroupFileList 返回的 folderInfo，说明书参考，待探测校准）。 */
export interface GroupFolderInfo {
    folderId: string;
    folderName: string;
    folderPath?: string;
    folderUid?: string;
    [key: string]: unknown;
}

/** 群文件空间信息（getGroupFileList 的 groupSpaceResult，说明书参考）。 */
export interface GroupSpaceInfo {
    retCode: number;
    retMsg: string;
    clientWording: string;
    totalSpace: number;
    usedSpace: number;
    allUpload: boolean;
}

/** 富媒体服务。 */
export interface NodeIKernelRichMediaService {
    addKernelRichMediaListener(listener: unknown): number;
    removeKernelRichMediaListener(listenerId: number): void;
    /** 英文单词翻译（translate_en2zh）。 */
    translateEnWordToZn(words: string[]): Promise<GeneralCallResult & { words?: string[] }>;
    /** 群文件列表（get_group_root_files / get_group_files_by_folder）。 */
    getGroupFileList(
        groupCode: string,
        params: GetFileListParam,
    ): Promise<
        GeneralCallResult & {
            groupSpaceResult?: GroupSpaceInfo;
            result?: unknown;
        }
    >;
    /** 创建群文件夹（create_group_file_folder）。 */
    createGroupFolder(groupCode: string, folderName: string): Promise<GeneralCallResult>;
    /** 删除群文件（delete_group_file；params 业务类型，Files 为文件 ID 列表）。 */
    deleteGroupFile(
        groupCode: string,
        params: number[],
        files: string[],
    ): Promise<GeneralCallResult>;
    /** 删除群文件夹（delete_group_folder）。 */
    deleteGroupFolder(groupCode: string, folderId: string): Promise<GeneralCallResult>;
    /** 重命名群文件（rename_group_file；参数待探测校准）。 */
    renameGroupFile(
        arg1: string,
        arg2: number,
        arg3: string,
        arg4: string,
        arg5: string,
    ): Promise<unknown>;
    /** 重命名群文件夹（rename_group_folder；形态镜像 renameGroupFile，待校准）。 */
    renameGroupFolder(
        arg1: string,
        arg2: number,
        arg3: string,
        arg4: string,
        arg5: string,
    ): Promise<unknown>;
    /** 移动群文件（move_group_file）。 */
    moveGroupFile(
        groupCode: string,
        busId: number[],
        fileList: string[],
        currentParentDirectory: string,
        targetParentDirectory: string,
    ): Promise<GeneralCallResult>;
    /** 转存群文件（trans_group_file）。 */
    transGroupFile(groupCode: string, fileId: string): Promise<GeneralCallResult>;
    /** 批量群文件数（get_group_file_system_info 补充）。 */
    batchGetGroupFileCount(
        groupCodes: string[],
    ): Promise<GeneralCallResult & { groupCodes?: string[]; groupFileCounts?: number[] }>;
    isNull(): boolean;
}
