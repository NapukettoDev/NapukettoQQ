/**
 * FlashTransferApi：闪传语义化 API（kernel design §15.5）
 *
 * 通道 = 「上传文件集 + 发分享卡片」：
 * - uploadFileSet：createFlashTransferUploadTask 调用即开始上传，等到每个文件都
 *   onFileDidFinishUpload 才返回（fileSetId 只能从事件取，返回值是空对象）；
 * - sendCard：sendFlashTransferMsg 把卡片发到群 / 私聊（destType 取 ChatType）。
 *
 * ⚠️ 语义边界：发出的是**分享链接卡片**（`qfile.qq.com`），不是 `fileElement` 文件消息，
 * 也不进群文件列表。文件消息路线被服务端传输命令拒（§15.3/§15.4），故本 API 是当前
 * 唯一可用的「把文件送到对端」的通道。
 */
import { kernelError } from "../infra/index.js";
import type { Peer } from "../types/entities.js";
import type {
    FlashTransferFileSet,
    FlashTransferTaskInfo,
    FlashTransferUploadListener,
    NodeIKernelFlashTransferService,
    NodeIQQNTWrapperSession,
} from "../types/index.js";
import { checkLooseResult } from "./result.js";

/** 上传默认超时（毫秒）：大文件留足时间，超时抛 TIMEOUT 而不是静默挂住。 */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** 路径分隔符（取文件名用）。 */
const PATH_SEPARATORS = /[\\/]/;

/** 闪传上传结果。 */
export interface FlashTransferUploadResult {
    /** 文件集 id（发卡片用）。 */
    fileSetId: string;
    /** 分享链接（`https://qfile.qq.com/q/…`，可能为空串——以 fileSetId 为准）。 */
    shareLink: string;
    /** 本次文件集的文件数。 */
    fileCount: number;
}

/** 上传选项。 */
export interface FlashTransferUploadOptions {
    /** 文件集名称（对端卡片标题）；缺省取首个文件名。 */
    name?: string;
    /** 分享权限码（permission.code，实测 0 = 链接可直接打开）。 */
    permissionCode?: number;
    /** 超时毫秒（缺省 10 分钟）。 */
    timeoutMs?: number;
}

/** 闪传 API：从 session 拿 flash transfer service，包装成语义化方法。 */
export class FlashTransferApi {
    private readonly service: NodeIKernelFlashTransferService;

    constructor(session: NodeIQQNTWrapperSession) {
        const service =
            session.getFlashTransferService() as unknown as NodeIKernelFlashTransferService | null;
        if (service === null || service === undefined) {
            throw kernelError(
                "getFlashTransferService() 返回空（session 未 init）",
                "INVALID_STATE",
            );
        }
        this.service = service;
    }

    /**
     * 上传文件集（`createFlashTransferUploadTask`）。所有文件 `onFileDidFinishUpload`
     * 后返回；超时 / 原生拒绝抛内核错误。空路径列表是参数错误（原生怕空集）。
     */
    async uploadFileSet(
        paths: string[],
        options: FlashTransferUploadOptions = {},
    ): Promise<FlashTransferUploadResult> {
        if (paths.length === 0) {
            throw kernelError("闪传上传需要至少一个文件路径", "INVALID_PARAM");
        }
        const timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS;
        const state = createUploadState();
        const listener: FlashTransferUploadListener = {
            onFileSetUploadStatusChanged(fileSet) {
                state.fileSet = fileSet;
            },
            onFileSetUploadProgressChanged(payload) {
                if (payload.fileSet !== undefined) {
                    state.fileSet = payload.fileSet;
                }
            },
            onFileDidFinishUpload(file) {
                if (typeof file.cliFileId === "string" && file.cliFileId !== "") {
                    state.finished.add(file.cliFileId);
                } else {
                    state.finishedFallback += 1;
                }
                if (state.isDone(paths.length)) {
                    state.settle();
                }
            },
        };

        const done = new Promise<void>((resolve, reject) => {
            state.settle = resolve;
            state.timer = setTimeout(() => {
                reject(
                    kernelError(
                        `闪传上传超时（${timeoutMs}ms，已完成 ${state.doneCount()}/${paths.length}）`,
                        "TIMEOUT",
                    ),
                );
            }, timeoutMs);
        });

        try {
            this.service.addFileSetUploadListener(listener);
            this.service.createFlashTransferUploadTask(listener, buildTaskInfo(paths, options));
        } catch (e) {
            clearTimer(state.timer);
            this.detachQuietly(listener);
            throw kernelError(
                `createFlashTransferUploadTask 失败: ${e instanceof Error ? e.message : String(e)}`,
                "UNKNOWN",
                { cause: e },
            );
        }

        try {
            await done;
        } finally {
            clearTimer(state.timer);
            this.detachQuietly(listener);
        }

        const fileSet = state.fileSet;
        const fileSetId = fileSet?.fileSetId ?? "";
        if (fileSetId === "") {
            throw kernelError("闪传上传结束但未取到 fileSetId（事件未携带）", "UNKNOWN");
        }
        return {
            fileSetId,
            shareLink: fileSet?.shareInfo?.shareLink ?? "",
            fileCount: paths.length,
        };
    }

    /** 发送闪传卡片（`sendFlashTransferMsg`；destType 取 Peer.chatType，destUid 取 peerUid）。 */
    async sendCard(target: Peer, fileSetId: string): Promise<void> {
        if (fileSetId === "") {
            throw kernelError("sendFlashTransferMsg 需要 fileSetId", "INVALID_PARAM");
        }
        const raw = await this.service.sendFlashTransferMsg({
            targets: [{ destType: target.chatType, destUid: target.peerUid }],
            fileSetId,
        });
        checkLooseResult("sendFlashTransferMsg", raw);
    }

    /** 上传 + 发卡片（常见一步用法）。 */
    async sendFile(
        target: Peer,
        paths: string[],
        options: FlashTransferUploadOptions = {},
    ): Promise<FlashTransferUploadResult> {
        const result = await this.uploadFileSet(paths, options);
        await this.sendCard(target, result.fileSetId);
        return result;
    }

    /** 注销监听器：失败不影响主流程（原生可能已卸载服务）。 */
    private detachQuietly(listener: FlashTransferUploadListener): void {
        try {
            this.service.removeFileSetUploadListener(listener);
        } catch {
            // 忽略：卸载失败只影响事件泄漏，不影响本次结果
        }
    }
}

/** 上传过程状态（事件回调与超时共用）。 */
interface UploadState {
    fileSet: FlashTransferFileSet | null;
    finished: Set<string>;
    finishedFallback: number;
    settle: () => void;
    timer: ReturnType<typeof setTimeout> | null;
    isDone: (expected: number) => boolean;
    doneCount: () => number;
}

/** 建初始状态（settle 由 Promise 构造器补）。 */
function createUploadState(): UploadState {
    const state: UploadState = {
        fileSet: null,
        finished: new Set<string>(),
        finishedFallback: 0,
        settle: () => {
            // 由 Promise 构造器替换；未替换前（事件早于注册）只忽略，isDone 仍会回调
        },
        timer: null,
        isDone: (expected: number) => state.doneCount() >= expected,
        doneCount: () => Math.max(state.finished.size, state.finishedFallback),
    };
    return state;
}

/** 组装 createFlashTransferUploadTask 的 taskInfo（字段来自运行时探测，缺一即抛）。 */
function buildTaskInfo(
    paths: string[],
    options: FlashTransferUploadOptions,
): FlashTransferTaskInfo {
    const firstName = paths[0]?.split(PATH_SEPARATORS).pop() ?? "";
    return {
        scene: 0,
        name: options.name ?? (firstName === "" ? "文件集" : firstName),
        uploaders: [],
        permission: { code: options.permissionCode ?? 0 },
        coverPath: "",
        coverOriginalInfos: [],
        paths,
        albumFilePathList: [],
        excludePaths: [],
        expireLeftTime: 0,
        validitySeconds: 0,
        uploadSceneType: 0,
        isNeedDelDeviceInfo: true,
        isNeedDelLocation: true,
        pathsWithPrivacyInfo: [],
        detectPrivacyInfoResult: { exists: false, allDetectResults: new Map() },
        hybridFileInfos: [],
        announcement: { announcementSegments: [], modifyTime: 0, avatarUrl: "" },
    };
}

/** 清理定时器（null 安全）。 */
function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) {
        clearTimeout(timer);
    }
}
