/**
 * MsgApi：消息语义化 API（ADR-009 统一错误语义）
 *
 * 内部解包原生 `{ result, errMsg }`：成功返回纯业务值，失败抛 KernelError。
 * 协议层只维护 `KernelErrorCode → 协议错误码` 映射表，不解析错误逻辑。
 *
 * 方法面（P2-1）：发送 / 撤回 / 拉历史 / 标记已读。group/friend 等后续 apis 同构。
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { MsgEventChannel } from "../bridge/msg-bridge.js";
import { kernelError } from "../infra/index.js";
import type {
    CanonicalElement,
    NodeIKernelMsgService,
    NodeIQQNTWrapperSession,
    Peer,
    PttElement,
    RawElement,
    RawMessage,
    SendMessageElement,
    VideoElement,
} from "../types/index.js";
import { ElementType, toSendElements } from "../types/index.js";
import { unwrapResult } from "./result.js";

/** 发送状态（onMsgInfoListUpdate 事件 msg.sendStatus）。 */
const SEND_STATUS = { FAILED: 0, SENDING: 1, SUCCESS: 2, SUCCESS_NO_SEQ: 3 } as const;

/** 发送确认超时（毫秒）。 */
const SEND_CONFIRM_TIMEOUT_MS = 15_000;

/**
 * PIC 元素发送契约值（NapCat 同款发送契约值，未逐字段校准）。
 * 下列固定值均为实测调通的 wrapper 发送契约（picType / picSubType /
 * picWidth / picHeight / original / thumbFileSize），只抽常量不改值——改值会破坏图片发送。
 */
const PIC_TYPE = 1000;
const PIC_SUB_TYPE = 0;
const PIC_WIDTH = 0;
const PIC_HEIGHT = 0;
const PIC_ORIGINAL = true;
const PIC_THUMB_FILE_SIZE = 0;

/**
 * PTT 元素发送契约值（NapCat 同款发送契约值，未逐字段校准）。
 * silk v3 协议：下列固定值均为实测调通的 wrapper 发送契约（formatType / voiceType /
 * voiceChangeType / canConvert2Text / playState / autoConvertText / storeID /
 * otherBusinessInfo.aiVoiceType），只抽常量不改值——改值会破坏语音发送。
 */
const PTT_FORMAT_TYPE = 1;
const PTT_VOICE_TYPE = 1;
const PTT_VOICE_CHANGE_TYPE = 0;
const PTT_CAN_CONVERT_2_TEXT = true;
const PTT_PLAY_STATE = 1;
const PTT_AUTO_CONVERT_TEXT = 0;
const PTT_STORE_ID = 0;
const PTT_AI_VOICE_TYPE = 0;
/** 假波形数组（占位波形）：无真实振幅数据时发送的固定占位，silk v3 协议契约值。 */
const PTT_WAVE_AMPLITUDES = [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17];

/**
 * VIDEO 元素发送契约值（2026-10-17 收向实测字段 + 发送实测调通）。
 *
 * 依据：历史视频消息 `getLatestDbMsgs` 的 videoElement 实测快照（fileFormat /
 * busiType / subBusiType / storeID / original / videoFrom / sourceVideoCodecFormat
 * 均为实测出现的取值）。2026-10-17 18:12 自建宿主实测调通：`sendMsg` 成功
 * （sendStatus 2/3，群内可播放）；关键坑是**缩略图目标路径必须用视频 md5**
 * （见 prepareVideoElement 注释），与字段取值无关。
 */
const VIDEO_FILE_FORMAT = 0;
const VIDEO_BUSI_TYPE = 0;
const VIDEO_SUB_BUSI_TYPE = 0;
const VIDEO_STORE_ID = 1;
const VIDEO_ORIGINAL = true;
const VIDEO_FROM = 0;
const VIDEO_SOURCE_CODEC_FORMAT = 0;
/** 视频缩略图在 thumbPath Map 中的 key（收向实测 Map<0, path>）。 */
const VIDEO_THUMB_KEY = 0;
/** getRichMediaFilePathForGuild 的 downloadType：1 = 原文件，2 = 缩略图。 */
const RICH_MEDIA_DOWNLOAD_TYPE_ORIGIN = 1;
const RICH_MEDIA_DOWNLOAD_TYPE_THUMB = 2;

/** downloadRichMedia 契约值（2026-09-08 B1 实测：downloadType=2 可用 / thumbSize=0）。 */
const DOWNLOAD_TYPE_COMMON = 2;
const THUMB_SIZE_NONE = 0;
/** 语音下载轮询参数（300ms × 34 ≈ 10s；返回 void 只能经重拉元素观察完成）。 */
const PTT_POLL_INTERVAL_MS = 300;
const PTT_POLL_TIMES = 34;

/** sleep（下载轮询间隔）。 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** 读文件 stat（富媒体发送预处理；文件不存在抛 INVALID_PARAM）。 */
async function statFile(path: string, label = "图片"): Promise<{ size: number }> {
    try {
        return await stat(path);
    } catch {
        throw kernelError(`${label}文件不存在: ${path}`, "INVALID_PARAM");
    }
}

/** 计算文件 md5（十六进制小写）。 */
async function hashFile(path: string, label = "图片"): Promise<string> {
    try {
        const buf = await readFile(path);
        return createHash("md5").update(buf).digest("hex");
    } catch {
        throw kernelError(`${label}文件读取失败: ${path}`, "INVALID_PARAM");
    }
}

/**
 * 清洗撤回消息 id（防御外部脏参数）。
 *
 * 调用方（IPC / 协议层 / koishi 适配器）可能传 null、非数组、空字符串等——
 * 直接透传会让裸 TypeError 逃逸，或把脏值一路送到 wrapper.node 才失败
 * （原生层只回「无错误详情」，排查困难）。规则：
 *  - 非数组 → INVALID_PARAM
 *  - 过滤空字符串 / 纯空白 / 非字符串
 *  - 清洗后为空 → INVALID_PARAM
 */
function sanitizeRecallMsgIds(msgIds: string[]): string[] {
    if (!Array.isArray(msgIds)) {
        throw kernelError("recallMessage 的 msgIds 必须是数组", "INVALID_PARAM");
    }
    const ids = msgIds.filter((id) => typeof id === "string" && id.trim() !== "");
    if (ids.length === 0) {
        throw kernelError("recallMessage 需要至少一个非空 msgId", "INVALID_PARAM");
    }
    return ids;
}

/** 消息 API：从 session 拿 msg service，包装成语义化方法。 */
export class MsgApi {
    private readonly service: NodeIKernelMsgService;
    /** 消息事件通道（sendMsg 后等 onMsgInfoListUpdate 确认发送结果）。 */
    private readonly channel: MsgEventChannel | null;
    /** NodeQQNTWrapperUtil（富媒体发送 copyFile 用；session 拿不到时可为 null）。 */
    private readonly util: { get(): unknown } | null;
    /** 上次生成 msgId 的时间（单调递增，2026-08-07 防同毫秒并发碰撞）。 */
    private lastMsgTime = 0;

    constructor(session: NodeIQQNTWrapperSession, channel?: MsgEventChannel, util?: unknown) {
        const service = session.getMsgService() as unknown as NodeIKernelMsgService | null;
        if (service === null || service === undefined) {
            throw kernelError("getMsgService() 返回空（session 未 init）", "INVALID_STATE");
        }
        this.service = service;
        this.channel = channel ?? null;
        // util 传入形态：构造器（NodeQQNTWrapperUtil，含 get()）或实例，宽松兼容
        this.util = util !== null && util !== undefined ? (util as { get(): unknown }) : null;
    }

    /**
     * 生成 msgId 时间戳（单调递增）。
     * generateMsgUniqueId(chatType, time) 以 time 区分消息——同毫秒并发发送
     * （机器人群发/多会话同时回复）Date.now() 会碰撞，msgId 相同导致 wrapper
     * 拒绝或覆盖。严格单调递增保证进程内唯一。
     */
    private nextMsgTime(): string {
        const now = Date.now();
        if (now > this.lastMsgTime) {
            this.lastMsgTime = now;
        } else {
            this.lastMsgTime += 1;
        }
        return String(this.lastMsgTime);
    }

    /**
     * 发送消息：canonical 元素 → NT 发送元素 → sendMsg（NapCat 式）。
     * 返回 NT msgId（雪花 ID）。
     *
     * 2026-08-11 修复（NapCat 式，实测）：
     *  - sendMsg 第一参传 '0'（固定），msgId 塞 peer.guildId —— 传 msgId 作第一参
     *    时 wrapper 返回 result=5（失败），NapCat 同款调用返回 result=0。
     *  - 发送结果以 onMsgInfoListUpdate 事件确认（sendStatus===2 成功）：sendMsg
     *    返回值 result 可能为 5 但事件仍成功（异步确认），反之亦然。
     *  - ⚠️ 必须先注册事件监听再调 sendMsg（事件可能在 sendMsg 返回前就触发）。
     */
    async sendMessage(target: Peer, elements: CanonicalElement[]): Promise<{ msgId: string }> {
        // NapCat 式富媒体预处理：PIC 元素补 md5/fileName/sourcePath 并放置文件
        // （getRichMediaFilePathForGuild → util.copyFile），否则发送器走未初始化
        // 的 FlashFileUploadService 导致 rich media transfer failed。
        const sendElements = await this.prepareSendElements(elements);
        const msgId = this.service.generateMsgUniqueId(target.chatType, this.nextMsgTime());
        // NapCat 同款：msgId 塞 guildId，第一参 '0'
        const sendPeer: Peer = { ...target, guildId: msgId };
        // 无事件通道（老用法）：退化为看返回值
        if (this.channel === null) {
            const raw = await this.service.sendMsg("0", sendPeer, sendElements, new Map());
            unwrapResult("sendMsg", raw);
            return { msgId };
        }
        // 有事件通道：先注册确认监听（NapCat 式，事件可能早于 sendMsg 返回触发），
        // 再调 sendMsg。最终结果以事件 sendStatus 为准（raw.result 非 0 不判失败）。
        const confirm = this.confirmSend(msgId, target);
        // ⚠️ 预消费 confirm 的 rejection（2026-08-22 崩溃根因修复）：若下方
        // service.sendMsg 抛错（wrapper 内部异常），confirm 确认监听已注册却无人
        // await，事件回调里 reject 会变成 unhandledRejection，Node 默认抛错退出
        // 直接拖垮整个子进程（实测：sendStatus=0 确认事件触发后进程崩溃、IPC
        // 通道关闭）。先挂 no-op 消费兜底，`await confirm` 仍能正常收到结果
        // （Promise 允许多个消费者），失败语义不变。
        confirm.catch(() => undefined);
        await this.service.sendMsg("0", sendPeer, sendElements, new Map());
        await confirm;
        return { msgId };
    }

    /**
     * canonical 元素 → 发送元素，富媒体（PIC/PTT）做 NapCat 式预处理。
     * 2026-08-11 修复（实测）：图片发送必须 elementType=2（PIC）+ 完整 picElement
     * （md5HexStr/fileSize/fileName/sourcePath），且文件须经 getRichMediaFilePathForGuild
     * 计算目标路径 + util.copyFile 放置——缺任一环节 sendMsg 返回 rich media transfer failed。
     * 2026-08-12（语音）：PTT 同理——只给 filePath 触发 wrapper 内部
     * "Cannot convert undefined or null to object"（缺字段转换失败）。
     */
    private async prepareSendElements(elements: CanonicalElement[]): Promise<SendMessageElement[]> {
        const out: SendMessageElement[] = [];
        for (const el of elements) {
            switch (el.type) {
                case "image":
                    out.push(await this.prepareImageElement(el.path));
                    break;
                case "voice":
                    out.push(await this.preparePttElement(el.path));
                    break;
                case "video":
                    out.push(await this.prepareVideoElement(el));
                    break;
                default:
                    out.push(...toSendElements([el]));
                    break;
            }
        }
        return out;
    }

    /** PIC 元素 NapCat 式预处理：md5 → 目标路径 → copyFile → 完整 picElement。 */
    private async prepareImageElement(path: string): Promise<SendMessageElement> {
        const file = await statFile(path);
        const md5 = await hashFile(path);
        const fileName = basename(path);
        const relPath = await this.placeMediaFile(path, ElementType.PIC, md5, fileName);
        return {
            elementType: ElementType.PIC,
            elementId: "",
            picElement: {
                md5HexStr: md5,
                fileSize: String(file.size),
                picWidth: PIC_WIDTH,
                picHeight: PIC_HEIGHT,
                fileName,
                sourcePath: relPath,
                original: PIC_ORIGINAL,
                picType: PIC_TYPE,
                picSubType: PIC_SUB_TYPE,
                fileUuid: "",
                fileSubId: "",
                thumbFileSize: PIC_THUMB_FILE_SIZE,
                summary: "",
            },
        };
    }

    /**
     * PTT 元素 NapCat 式预处理：md5 → 目标路径 → copyFile → 完整 pttElement。
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
        if (util !== null) {
            const instance = typeof util.get === "function" ? util.get() : util;
            const copy = (instance as Record<string, unknown>)["copyFile"];
            if (typeof copy === "function") {
                await (copy as (a: string, b: string) => Promise<unknown>).call(
                    instance,
                    path,
                    relPath,
                );
            }
        }
        return relPath;
    }

    /** 注册 onMsgInfoListUpdate 确认监听（返回 Promise，resolve 时发送成功）。 */
    private confirmSend(msgId: string, target: Peer): Promise<void> {
        const channel = this.channel;
        if (channel === null) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const off = channel.on("Msg/onMsgInfoListUpdate", (list) => {
                const mine = list.find((m) => m.guildId === msgId);
                if (mine === undefined) {
                    return; // 不是本次消息
                }
                if (
                    mine.sendStatus === SEND_STATUS.SUCCESS ||
                    mine.sendStatus === SEND_STATUS.SUCCESS_NO_SEQ
                ) {
                    off();
                    resolve();
                } else if (mine.sendStatus === SEND_STATUS.FAILED) {
                    off();
                    reject(
                        kernelError(`sendMsg 失败: sendStatus=${mine.sendStatus}`, "SEND_FAILED"),
                    );
                }
                // SENDING：继续等
            });
            // 超时兜底
            setTimeout(() => {
                off();
                reject(
                    kernelError(
                        `sendMsg 等待确认超时（msgId=${msgId}, target=${JSON.stringify(target)}）`,
                        "SEND_FAILED",
                    ),
                );
            }, SEND_CONFIRM_TIMEOUT_MS);
        });
    }

    /** 撤回消息（群聊管理员 / 私聊 2 分钟内）。 */
    async recallMessage(target: Peer, msgIds: string[]): Promise<void> {
        const raw = await this.service.recallMsg(target, sanitizeRecallMsgIds(msgIds));
        unwrapResult("recallMsg", raw);
    }

    /** 拉取历史消息（msgId 为空从最新拉；count 条，时间倒序）。 */
    async fetchMessages(
        target: Peer,
        opts: { count: number; msgId?: string },
    ): Promise<RawMessage[]> {
        const raw = await this.service.getMsgs(target, opts.msgId ?? "", opts.count, false);
        unwrapResult("getMsgs", raw);
        return raw.msgList ?? [];
    }

    /** 按 msgId 批量拉取消息（get_msg / 精华消息 / ptt 转文字共用）。 */
    async fetchMsgsByMsgId(target: Peer, ids: string[]): Promise<RawMessage[]> {
        if (ids.length === 0) {
            return [];
        }
        const raw = await this.service.getMsgsByMsgId(target, ids);
        unwrapResult("getMsgsByMsgId", raw);
        return raw.msgList ?? [];
    }

    /** 消息表情表态（set_msg_emoji_like；like=true 点赞，false 取消）。 */
    async setMsgEmojiLike(
        target: Peer,
        opts: { msgSeq: string; emojiId: string; emojiType: string; like: boolean },
    ): Promise<void> {
        const raw = await this.service.setMsgEmojiLikes(
            target,
            opts.msgSeq,
            opts.emojiId,
            opts.emojiType,
            opts.like,
        );
        unwrapResult("setMsgEmojiLikes", raw);
    }

    /**
     * 语音转文字（fetch_ptt_text）。
     * 流程：按 msgId 拉消息 → 找 PTT 元素 → translatePtt2Text（异步转写）
     * → 再拉一次消息读 pttElement.text。
     */
    async fetchPttText(msgId: string, target: Peer): Promise<string> {
        const msgs = await this.fetchMsgsByMsgId(target, [msgId]);
        const ptt = findPttElement(msgs);
        if (ptt === null) {
            throw kernelError("消息中不包含语音", "NOT_FOUND");
        }
        const raw = await this.service.translatePtt2Text(msgId, target, ptt);
        unwrapResult("translatePtt2Text", raw);
        // 转写异步完成：再拉一次拿 text
        const after = await this.fetchMsgsByMsgId(target, [msgId]);
        const text = findPttElement(after)?.pttElement?.text;
        if (text === undefined || text === "") {
            throw kernelError("获取语音转文字结果失败", "UNKNOWN");
        }
        return text;
    }

    /** 标记会话已读。 */
    async markRead(target: Peer): Promise<void> {
        const raw = await this.service.setMsgRead(target);
        unwrapResult("setMsgRead", raw);
    }

    /**
     * 语音主动下载（get_record 本地未命中兜底，2026-09-08 B1）。
     * downloadRichMedia 返回 void（实测），完成信号 = 重拉消息元素：
     * 轮询（300ms × 34，约 10s）直到 filePath 非空且 transferStatus 进入
     * 已下载态（2/4）；超时但 filePath 已有值则尽力返回（磁盘命中判断留给
     * 调用方），完全无路径抛 NOT_FOUND。
     */
    async downloadPtt(msgId: string, target: Peer): Promise<PttElement> {
        const msgs = await this.fetchMsgsByMsgId(target, [msgId]);
        const el = findPttElement(msgs);
        const ptt = el?.pttElement;
        if (el === null || ptt === undefined) {
            throw kernelError("消息中不包含语音", "NOT_FOUND");
        }
        const elemId = el.elementId ?? "";
        await this.service.downloadRichMedia({
            msgId,
            elemId,
            chatType: target.chatType,
            downloadType: DOWNLOAD_TYPE_COMMON,
            thumbSize: THUMB_SIZE_NONE,
        });
        for (let i = 0; i < PTT_POLL_TIMES; i++) {
            await sleep(PTT_POLL_INTERVAL_MS);
            const again = await this.fetchMsgsByMsgId(target, [msgId]);
            const latest = findPttElement(again)?.pttElement;
            if (latest === undefined) {
                continue;
            }
            const done = latest.transferStatus === 2 || latest.transferStatus === 4;
            if (latest.filePath !== undefined && latest.filePath !== "" && done) {
                return latest;
            }
            if (
                i === PTT_POLL_TIMES - 1 &&
                latest.filePath !== undefined &&
                latest.filePath !== ""
            ) {
                return latest;
            }
        }
        throw kernelError("语音下载未完成（超时）", "TIMEOUT");
    }

    /** 发送输入状态（set_input_status；eventType=1 输入中，0 停止）。 */
    async setInputStatus(target: Peer, eventType: number): Promise<void> {
        await this.service.sendShowInputStatusReq(target.chatType, eventType, target.peerUid);
    }

    /**
     * 发送合并转发（send_group/private_forward_msg）。
     * buildMultiForwardMsg 组装 MULTI_FORWARD 元素 → 直接作 sendMsg 元素发送。
     */
    async sendForwardMessage(
        target: Peer,
        sourcePeer: Peer,
        srcMsgIds: string[],
    ): Promise<{ msgId: string }> {
        if (srcMsgIds.length === 0) {
            throw kernelError("sendForwardMessage 需要至少一条源消息", "INVALID_PARAM");
        }
        const built = await this.service.buildMultiForwardMsg({
            srcMsgIds,
            srcContact: sourcePeer,
        });
        unwrapResult("buildMultiForwardMsg", built);
        const elements = built.rspInfo?.elements;
        if (elements === undefined || elements.length === 0) {
            throw kernelError("合并转发组装失败：无元素", "UNKNOWN");
        }
        const msgId = this.service.generateMsgUniqueId(target.chatType, String(Date.now()));
        const raw = await this.service.sendMsg(msgId, target, elements, new Map());
        unwrapResult("sendMsg", raw);
        return { msgId };
    }

    /** 获取合并转发内容（get_forward_msg；resId 取自 multiForwardMsgElement）。 */
    async fetchForwardMessage(peer: Peer, msgId: string): Promise<RawMessage[]> {
        const msgs = await this.fetchMsgsByMsgId(peer, [msgId]);
        const forward = findForwardElement(msgs);
        if (forward === null || forward.resId === "") {
            throw kernelError("消息不包含合并转发内容", "NOT_FOUND");
        }
        const raw = await this.service.getMultiMsg(peer, msgId, forward.resId);
        unwrapResult("getMultiMsg", raw);
        return raw.msgList ?? [];
    }

    /** 单条转发（forward_group/friend_single_msg；srcMsgIds 源、dstPeer 目标）。 */
    async forwardSingleMessage(
        sourcePeer: Peer,
        srcMsgIds: string[],
        dstPeer: Peer,
    ): Promise<void> {
        if (srcMsgIds.length === 0) {
            throw kernelError("forwardSingleMessage 需要至少一条源消息", "INVALID_PARAM");
        }
        const raw = await this.service.forwardMsg(srcMsgIds, sourcePeer, [dstPeer], undefined);
        unwrapResult("forwardMsg", raw);
    }

    /** 设置在线状态（set_online_status；customStatus 为自定义状态）。 */
    async setOnlineStatus(opts: {
        status: number;
        extStatus: number;
        batteryStatus: number;
        customStatus?: { faceId: string; wording: string; faceType: string };
    }): Promise<void> {
        const raw = await this.service.setStatus(opts);
        unwrapResult("setStatus", raw);
    }
}

/** 在消息列表中找含 pttElement 的元素（找不到返回 null）。 */
function findPttElement(msgs: RawMessage[]): RawElement | null {
    const [first] = msgs;
    if (first === undefined) {
        return null;
    }
    return first.elements.find((el) => el.pttElement !== undefined) ?? null;
}

/** 在消息列表中找含 multiForwardMsgElement 的元素（找不到返回 null）。 */
function findForwardElement(
    msgs: RawMessage[],
): { resId: string; fileName: string; xmlContent: string } | null {
    const [first] = msgs;
    if (first === undefined) {
        return null;
    }
    return (
        first.elements.find((el) => el.multiForwardMsgElement !== undefined)
            ?.multiForwardMsgElement ?? null
    );
}
