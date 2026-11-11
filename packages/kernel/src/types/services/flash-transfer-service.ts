/**
 * NodeIKernelFlashTransferService：闪传服务接口面（自研描述，非移植）
 *
 * 依据：运行时探测（kernel design §15）。接口签名是外部系统的事实，此处自研描述其形状，
 * 零复制实现。只收录 apis/flash-transfer 用到的方法；其余按需探测后补齐。
 *
 * 通道语义：**上传文件集 + 发分享卡片**（`qfile.qq.com` 链接），不是 `fileElement`
 * 文件消息，也不进群文件列表——对外文档必须写清（§15.5）。
 */
import type { GeneralCallResult } from "./msg-service.js";

/** 闪传分享权限（permission.code，语义待校准；实测 0 = 链接可直接打开）。 */
export interface FlashTransferPermission {
    code: number;
}

/** 卡片发送目标：destType 取 ChatType（2 = 群、1 = 私聊），destUid 取群号 / 用户 uid。 */
export interface FlashTransferTarget {
    destType: number;
    destUid: string;
}

/** 上传任务参数（createFlashTransferUploadTask 第 2 参，原生逐字段读取的 20 项）。 */
export interface FlashTransferTaskInfo {
    scene: number;
    name: string;
    uploaders: string[];
    permission: FlashTransferPermission;
    coverPath: string;
    coverOriginalInfos: unknown[];
    paths: string[];
    albumFilePathList: string[];
    excludePaths: string[];
    expireLeftTime: number;
    validitySeconds: number;
    uploadSceneType: number;
    isNeedDelDeviceInfo: boolean;
    isNeedDelLocation: boolean;
    pathsWithPrivacyInfo: unknown[];
    detectPrivacyInfoResult: { exists: boolean; allDetectResults: Map<unknown, unknown> };
    hybridFileInfos: unknown[];
    announcement: { announcementSegments: unknown[]; modifyTime: number; avatarUrl: string };
}

/** 文件集快照（事件回调第 1 参；只收录本 API 用到的字段）。 */
export interface FlashTransferFileSet {
    fileSetId: string;
    name?: string;
    totalFileCount?: string;
    totalFileSize?: string;
    permission?: FlashTransferPermission;
    shareInfo?: { shareLink?: string; extractionCode?: string };
    [key: string]: unknown;
}

/** 单个文件的状态快照（fileSet 内条目）。 */
export interface FlashTransferFileStatus {
    fileSetId: string;
    cliFileId: string;
    name: string;
    fileType?: number;
    [key: string]: unknown;
}

/**
 * 上传监听器（delegate）：原生按名取回调，未定义的事件直接跳过。
 * 实测事件序列：onFileDidStartUpload → onFileUploadStatusChanged → onFileSetUploadStatusChanged
 * → onFileSetUploadProgressChanged / onFileUploadProgressChanged → onFileDidFinishUpload。
 */
export interface FlashTransferUploadListener {
    onFileDidStartUpload?(file: FlashTransferFileStatus): void;
    onFileUploadStatusChanged?(file: FlashTransferFileStatus): void;
    onFileSetUploadStatusChanged?(fileSet: FlashTransferFileSet): void;
    onFileSetUploadProgressChanged?(payload: {
        fileSet: FlashTransferFileSet;
        uploaded: string;
        total: string;
    }): void;
    onFileUploadProgressChanged?(file: FlashTransferFileStatus, ...args: string[]): void;
    onFileDidFinishUpload?(file: FlashTransferFileStatus): void;
}

/** 闪传服务。 */
export interface NodeIKernelFlashTransferService {
    addFileSetUploadListener(listener: FlashTransferUploadListener): void;
    removeFileSetUploadListener(listener: FlashTransferUploadListener): void;
    /** 创建上传任务；**调用即开始上传**，返回值是空对象（fileSetId 只能从事件取）。 */
    createFlashTransferUploadTask(
        listener: FlashTransferUploadListener,
        taskInfo: FlashTransferTaskInfo,
    ): unknown;
    /** 发送闪传卡片消息（targets 元素只读 destType / destUid 两个字段）。 */
    sendFlashTransferMsg(params: {
        targets: FlashTransferTarget[];
        fileSetId: string;
    }): Promise<GeneralCallResult> | GeneralCallResult;
}
