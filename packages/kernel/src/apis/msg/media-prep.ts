/**
 * 媒体元素准备（canonical → NT 发送元素，NapCat 式链路）
 *
 * 2026-11 从 `apis/msg.ts` 拆出：图片 / 语音 / 视频 / 文件的 md5 计算、QQ 内部
 * 目标路径解析（getRichMediaFilePathForGuild）、copyFile 落盘与完整元素字段装配。
 * 固定契约值在 `media-contract.ts`，文件 IO 原语在 `media-io.ts`。
 */
import { basename, extname } from "node:path";
import { toSendElements } from "../../codec/index.js";
import { hasCallableProp } from "../../infra/index.js";
import type {
    CanonicalElement,
    NodeIKernelMsgService,
    SendMessageElement,
    VideoElement,
} from "../../types/index.js";
import { ElementType, VIDEO_THUMB_KEY } from "../../types/index.js";
import { probeImageMetaFallback, resolvePicType } from "./image-meta.js";
import {
    PIC_FALLBACK_SIZE,
    PIC_ORIGINAL,
    PIC_SUB_TYPE,
    PIC_THUMB_FILE_SIZE,
    PTT_AI_VOICE_TYPE,
    PTT_AUTO_CONVERT_TEXT,
    PTT_CAN_CONVERT_2_TEXT,
    PTT_FORMAT_TYPE,
    PTT_PLAY_STATE,
    PTT_STORE_ID,
    PTT_VOICE_CHANGE_TYPE,
    PTT_VOICE_TYPE,
    PTT_WAVE_AMPLITUDES,
    RICH_MEDIA_DOWNLOAD_TYPE_ORIGIN,
    RICH_MEDIA_DOWNLOAD_TYPE_THUMB,
    VIDEO_BUSI_TYPE,
    VIDEO_FILE_FORMAT,
    VIDEO_FROM,
    VIDEO_ORIGINAL,
    VIDEO_SOURCE_CODEC_FORMAT,
    VIDEO_STORE_ID,
    VIDEO_SUB_BUSI_TYPE,
} from "./media-contract.js";
import { hashFile, statFile } from "./media-io.js";

/**
 * 正整数校验：`0` / 负数 / 非安全整数一律视为「未探测到」。
 * canonical `size` 可能来自外部协议层，不能直接当成有效宽高写进 picElement。
 */
function positiveInt(value: number | undefined): number | undefined {
    return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 清洗 canonical MIME：IPC / 第三方可能传非字符串脏值，统一按缺失处理。 */
function normalizeMime(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * 媒体元素准备器：持有 msg service 与 NodeQQNTWrapperUtil（copyFile 用）。
 *
 * 一次构造、多次发送——service / util 在 MsgApi 生命周期内不变。
 */
export class MediaPreparer {
    private readonly service: NodeIKernelMsgService;
    private readonly util: unknown;

    constructor(service: NodeIKernelMsgService, util: unknown) {
        this.service = service;
        // util 传入形态：构造器（NodeQQNTWrapperUtil，含 get()）或实例，宽松兼容
        this.util = util ?? null;
    }

    /**
     * canonical 元素 → 发送元素，富媒体（PIC/PTT）做 NapCat 式预处理。
     * 2026-08-11 修复（实测）：图片发送必须 elementType=2（PIC）+ 完整 picElement
     * （md5HexStr/fileSize/fileName/sourcePath），且文件须经 getRichMediaFilePathForGuild
     * 计算目标路径 + util.copyFile 放置——缺任一环节 sendMsg 返回 rich media transfer failed。
     * 2026-08-12（语音）：PTT 同理——只给 filePath 触发 wrapper 内部
     * "Cannot convert undefined or null to object"（缺字段转换失败）。
     */
    async prepareSendElements(elements: CanonicalElement[]): Promise<SendMessageElement[]> {
        const out: SendMessageElement[] = [];
        for (const el of elements) {
            switch (el.type) {
                case "image":
                    out.push(await this.prepareImageElement(el));
                    break;
                case "voice":
                    out.push(await this.preparePttElement(el.path));
                    break;
                case "video":
                    out.push(await this.prepareVideoElement(el));
                    break;
                case "file":
                    out.push(await this.prepareFileElement(el));
                    break;
                default:
                    out.push(...toSendElements([el]));
                    break;
            }
        }
        return out;
    }

    /**
     * PIC 元素 NapCat 式预处理：md5 → 目标路径 → copyFile → 完整 picElement。
     *
     * 图片尺寸/MIME 优先取 canonical（adapter 已用 `@napuketto/media` 探测并写入
     * `size` / `mime`）；缺任一项时（IPC 直发、第三方直接调 kernel）用本包的
     * 零依赖文件头解析兜底补齐，`picType` 按真实类型映射。硬编码 0/0/1000
     * 会让手机端 QQ 收到的图片消息显示空白（上传本身成功）。
     */
    private async prepareImageElement(
        el: Extract<CanonicalElement, { type: "image" }>,
    ): Promise<SendMessageElement> {
        const file = await statFile(el.path);
        const md5 = await hashFile(el.path);
        const fileName = basename(el.path);
        const relPath = await this.placeMediaFile(el.path, ElementType.PIC, md5, fileName);
        const width = positiveInt(el.size?.width);
        const height = positiveInt(el.size?.height);
        const mime = normalizeMime(el.mime);
        // 任一维度或 MIME 缺失 → 读文件头补齐（探测失败静默返回空，不阻断发送）。
        let picWidth = width;
        let picHeight = height;
        let picMime = mime;
        if (width === undefined || height === undefined || mime === undefined) {
            const probed = await probeImageMetaFallback(el.path);
            picWidth = width ?? probed.width;
            picHeight = height ?? probed.height;
            picMime = mime ?? probed.mime;
        }
        return {
            elementType: ElementType.PIC,
            elementId: "",
            picElement: {
                md5HexStr: md5,
                fileSize: String(file.size),
                picWidth: picWidth ?? PIC_FALLBACK_SIZE,
                picHeight: picHeight ?? PIC_FALLBACK_SIZE,
                fileName,
                sourcePath: relPath,
                original: PIC_ORIGINAL,
                picType: resolvePicType(picMime, el.path),
                picSubType: PIC_SUB_TYPE,
                fileUuid: "",
                fileSubId: "",
                thumbFileSize: PIC_THUMB_FILE_SIZE,
                summary: "",
            },
        };
    }

    /**
     * PTT 元素预处理：md5 → 目标路径 → copyFile → 完整 pttElement。
     *
     * 2026-08-12（实测依据）：只给 filePath 时 wrapper 内部抛
     * "Cannot convert undefined or null to object"（缺 md5HexStr/fileSize 等字段），
     * 且发送后进程崩溃重启（supervisor 自动拉起）。完整字段（NapCat 同款，
     * formatType/voiceType/canConvert2Text/waveAmplitudes 等）消除该错误。
     *
     * ⚠️ silk 格式：QQ 语音协议为 silk v3。非 silk → silk 的转码在协议层
     * （adapter，@napuketto/media 的 encodePcmToSilk，2026-08-12 接线）完成，
     * 此处接收的已是 silk 路径，仅做放置。kernel 不 import media（解耦红线）。
     */
    private async preparePttElement(path: string): Promise<SendMessageElement> {
        const file = await statFile(path);
        const md5 = await hashFile(path);
        const fileName = basename(path);
        const relPath = await this.placeMediaFile(path, ElementType.PTT, md5, fileName);
        // 时长估算（NapCat 同款规则：~3KB/s 语音码率，缺 ffprobe 时兜底）
        const duration = Math.max(1, Math.floor(file.size / 1024 / 3));
        return {
            elementType: ElementType.PTT,
            elementId: "",
            pttElement: {
                fileName,
                filePath: relPath,
                md5HexStr: md5,
                fileSize: String(file.size),
                duration,
                formatType: PTT_FORMAT_TYPE,
                voiceType: PTT_VOICE_TYPE,
                voiceChangeType: PTT_VOICE_CHANGE_TYPE,
                canConvert2Text: PTT_CAN_CONVERT_2_TEXT,
                waveAmplitudes: PTT_WAVE_AMPLITUDES,
                fileSubId: "",
                playState: PTT_PLAY_STATE,
                autoConvertText: PTT_AUTO_CONVERT_TEXT,
                storeID: PTT_STORE_ID,
                otherBusinessInfo: { aiVoiceType: PTT_AI_VOICE_TYPE },
            },
        };
    }

    /**
     * VIDEO 元素预处理：md5 → 目标路径 → copyFile → 完整 videoElement。
     *
     * 字段依据：2026-10-17 收向实测（历史视频消息 videoElement 全字段快照）+
     * 发送实测（2026-10-17 18:12 自建宿主发送成功，群内可播放）：
     *  1. `thumbPath` 必须是真实 `Map<number, string>`（收向实测 `Map<0, path>`）——
     *     经 JSON/IPC 传参会退化成 `{}`，wrapper 转换失败；
     *  2. **缩略图目标路径用视频 md5**（`Video/<YYYY-MM>/Thumb/<videoMd5>_0.png`）：
     *     真实消息实测 videoMd5=`3d27…`、thumbMd5=`46da…`，落盘文件名却是
     *     `3d27…_0.png`；此前按 thumbMd5 放置 → native 传输按视频 md5 找不到缩略图
     *     → `rich media transfer failed`（20+ 组字段变体都无效的真正原因）；
     *  3. `thumbMd5` 是缩略图**内容**的 md5，与文件名无关；`fileTime` 为秒。
     */
    private async prepareVideoElement(
        el: Extract<CanonicalElement, { type: "video" }>,
    ): Promise<SendMessageElement> {
        const file = await statFile(el.path, "视频");
        const md5 = await hashFile(el.path, "视频");
        const fileName = basename(el.path);
        const relPath = await this.placeMediaFile(
            el.path,
            ElementType.VIDEO,
            md5,
            fileName,
            RICH_MEDIA_DOWNLOAD_TYPE_ORIGIN,
        );
        const videoElement: VideoElement = {
            fileName,
            filePath: relPath,
            fileSize: String(file.size),
            videoMd5: md5,
            fileTime: el.durationSec ?? 0,
            fileFormat: VIDEO_FILE_FORMAT,
            busiType: VIDEO_BUSI_TYPE,
            subBusiType: VIDEO_SUB_BUSI_TYPE,
            fileUuid: "",
            fileSubId: "",
            storeID: VIDEO_STORE_ID,
            original: VIDEO_ORIGINAL,
            videoFrom: VIDEO_FROM,
            sourceVideoCodecFormat: VIDEO_SOURCE_CODEC_FORMAT,
        };
        if (el.thumbPath !== undefined && el.thumbPath !== "") {
            const thumbSize = await statFile(el.thumbPath, "视频缩略图");
            const thumbMd5 = await hashFile(el.thumbPath, "视频缩略图");
            // ⚠️ 目标路径必须用**视频 md5**（不是缩略图内容 md5）：2026-10-17 实测
            // 真实视频消息的缩略图文件名为 `Thumb/<videoMd5>_0.png`，而
            // `thumbMd5` 只是缩略图内容的 md5（例：videoMd5=3d27…、thumbMd5=46da…，
            // 实际落盘 `3d27…_0.png`）。此前用 thumbMd5 算路径 → native 传输按视频
            // md5 找不到缩略图 → `rich media transfer failed`。
            const thumbRelPath = await this.placeMediaFile(
                el.thumbPath,
                ElementType.VIDEO,
                md5,
                `${md5}${extname(el.thumbPath)}`,
                RICH_MEDIA_DOWNLOAD_TYPE_THUMB,
            );
            videoElement.thumbMd5 = thumbMd5;
            videoElement.thumbSize = thumbSize.size;
            videoElement.thumbWidth = el.width ?? 0;
            videoElement.thumbHeight = el.height ?? 0;
            videoElement.thumbPath = new Map([[VIDEO_THUMB_KEY, thumbRelPath]]);
        }
        return { elementType: ElementType.VIDEO, elementId: "", videoElement };
    }

    /**
     * FILE 元素预处理（P2-2 预留口子，upload_private/group_file 落地）：
     * pic/ptt/video 同款 NapCat 式链路——md5 → getRichMediaFilePathForGuild(FILE)
     * → copyFile → 完整 fileElement。链路模式已验证（三类媒体同构）；fileElement
     * 字段值（fileSize 字符串形态、fileUuid 空串等）待探测校准。
     */
    private async prepareFileElement(
        el: Extract<CanonicalElement, { type: "file" }>,
    ): Promise<SendMessageElement> {
        const file = await statFile(el.path, "文件");
        const md5 = await hashFile(el.path, "文件");
        const fileName = el.name !== undefined && el.name !== "" ? el.name : basename(el.path);
        const relPath = await this.placeMediaFile(el.path, ElementType.FILE, md5, fileName);
        return {
            elementType: ElementType.FILE,
            elementId: "",
            fileElement: {
                fileName,
                filePath: relPath,
                fileSize: String(file.size),
                fileUuid: "",
            },
        };
    }

    /**
     * 富媒体文件放置（PIC/PTT/VIDEO 共用）：md5 + 文件名 → QQ 内部目标路径
     * （getRichMediaFilePathForGuild）→ util.copyFile 放置 → 返回目标路径。
     *
     * `downloadType`：1 = 原文件（Ori），2 = 缩略图（Thumb，视频缩略图必须）。
     */
    private async placeMediaFile(
        path: string,
        elementType: ElementType,
        md5: string,
        fileName: string,
        downloadType = RICH_MEDIA_DOWNLOAD_TYPE_ORIGIN,
    ): Promise<string> {
        const service = this.service;
        const util = this.util;
        // getRichMediaFilePathForGuild：QQ 内部目标路径（纯文件名，相对数据根）。
        // 固定入参 elementSubType / thumbSize / downloadType 为 NapCat 同款发送契约值
        // （未逐字段校准），发送方向固定，改值会破坏富媒体路径计算。
        const relPath = service.getRichMediaFilePathForGuild({
            md5HexStr: md5,
            fileName,
            elementType,
            elementSubType: 0, // 元素子类型（发送固定 0）
            thumbSize: 0, // 缩略图尺寸（发送固定 0，不预生成缩略图）
            needCreate: true,
            downloadType, // 下载类型：1 = 原文件，2 = 缩略图（视频缩略图必须）
            file_uuid: "",
        });
        if (util !== null && util !== undefined) {
            const instance = hasCallableProp(util, "get") ? util.get() : util;
            if (hasCallableProp(instance, "copyFile")) {
                try {
                    await instance.copyFile(path, relPath);
                } catch {
                    // 原生 copyFile 失败不阻断发送：后续走 wrapper 自身下载路径
                }
            }
        }
        return relPath;
    }
}
