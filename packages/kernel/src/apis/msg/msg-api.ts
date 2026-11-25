/**
 * MsgApi：消息语义化 API 门面（ADR-009 统一错误语义）
 *
 * 内部解包原生 `{ result, errMsg }`：成功返回纯业务值，失败抛 KernelError。
 * 协议层只维护 `KernelErrorCode → 协议错误码` 映射表，不解析错误逻辑。
 *
 * 2026-11 从单文件 `apis/msg.ts` 拆分：媒体预处理（media-prep）、发送确认
 * （send-confirm）、转发（forward）、语音（ptt）、共享查询（queries）各自成
 * 模块，本文件只做门面编排与方法委派。
 */
import {
    errorMessage,
    isKernelError,
    isRecord,
    kernelError,
    requireKernelService,
} from "../../infra/index.js";
import type { MsgEventChannel } from "../../native/bridge/index.js";
import type {
    CanonicalElement,
    NodeIKernelMsgService,
    NodeIQQNTWrapperSession,
    NudgeParam,
    Peer,
    PttElement,
    RawMessage,
} from "../../types/index.js";
import { ChatType } from "../../types/index.js";
import { checkLooseResult, unwrapResult } from "../result.js";
import { fetchForwardMessage, forwardSingleMessage, sendForwardMessage } from "./forward.js";
import { MediaPreparer } from "./media-prep.js";
import { downloadPtt, fetchPttText } from "./ptt.js";
import { fetchMessages, fetchMsgsByMsgId } from "./queries.js";
import { confirmSend, MsgIdSequencer } from "./send-confirm.js";

const QQ_EMOJI_ID_PATTERN = /^\d+$/;
const MESSAGE_SEQ_PATTERN = /^[1-9]\d*$/;

/** 收藏表情项 → url（字段名待校准，url/imageUrl/emojiUrl 逐个兜底）。 */
function extractFavEmojiUrls(list: unknown[]): string[] {
    const out: string[] = [];
    for (const item of list) {
        if (!isRecord(item)) {
            continue;
        }
        const url = item["url"] ?? item["imageUrl"] ?? item["emojiUrl"];
        if (typeof url === "string" && url !== "") {
            out.push(url);
        }
    }
    return out;
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
    /** msgId 时间戳生成器（单调递增，防同毫秒并发碰撞）。 */
    private readonly ids = new MsgIdSequencer();
    /** 富媒体元素准备器（md5 / 目标路径 / copyFile 落盘）。 */
    private readonly media: MediaPreparer;

    constructor(session: NodeIQQNTWrapperSession, channel?: MsgEventChannel, util?: unknown) {
        this.service = requireKernelService(session.getMsgService(), "getMsgService", [
            "sendMsg",
            "recallMsg",
            "getMsgs",
        ]);
        this.channel = channel ?? null;
        this.media = new MediaPreparer(this.service, util);
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
     *  - msgId 以确认事件里那条消息的 msgId 为准（2026-11-09 Linux E2E 实测）：
     *    自己 generateMsgUniqueId 出来的 id 只落在确认事件的 guildId 字段上，
     *    按它去 get_msg / recallMsg 会查不到（消息确实已发出去）。优先返回事件
     *    消息的 msgId，缺失时回退生成的 id（老行为，Windows 侧不变）。
     */
    async sendMessage(target: Peer, elements: CanonicalElement[]): Promise<{ msgId: string }> {
        // NapCat 式富媒体预处理：PIC 元素补 md5/fileName/sourcePath 并放置文件
        // （getRichMediaFilePathForGuild → util.copyFile），否则发送器走未初始化
        // 的 FlashFileUploadService 导致 rich media transfer failed。
        const sendElements = await this.media.prepareSendElements(elements);
        const msgId = this.service.generateMsgUniqueId(target.chatType, this.ids.next());
        // NapCat 同款：msgId 塞 guildId，第一参 '0'
        const sendPeer: Peer = { ...target, guildId: msgId };
        // 无事件通道（老用法）：退化为看返回值
        const channel = this.channel;
        if (channel === null) {
            const raw = await this.service.sendMsg("0", sendPeer, sendElements, new Map());
            unwrapResult("sendMsg", raw);
            return { msgId };
        }
        // 有事件通道：先注册确认监听（NapCat 式，事件可能早于 sendMsg 返回触发），
        // 再调 sendMsg。最终结果以事件 sendStatus 为准（raw.result 非 0 不判失败）。
        const confirm = confirmSend(channel, msgId, target);
        // ⚠️ 预消费 confirm 的 rejection（2026-08-22 崩溃根因修复）：若下方
        // service.sendMsg 抛错（wrapper 内部异常），confirm 确认监听已注册却无人
        // await，事件回调里 reject 会变成 unhandledRejection，Node 默认抛错退出
        // 直接拖垮整个子进程（实测：sendStatus=0 确认事件触发后进程崩溃、IPC
        // 通道关闭）。先挂 no-op 消费兜底，`await confirm` 仍能正常收到结果
        // （Promise 允许多个消费者），失败语义不变。
        confirm.catch(() => undefined);
        await this.service.sendMsg("0", sendPeer, sendElements, new Map());
        const confirmed = await confirm;
        // 事件消息的 msgId 为准；确认事件没带 msgId（老 wrapper/测试桩）时回退生成值
        return { msgId: confirmed.msgId || msgId };
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
        return fetchMessages(this.service, target, opts);
    }

    /** 按 msgId 批量拉取消息（get_msg / 精华消息 / ptt 转文字共用）。 */
    async fetchMsgsByMsgId(target: Peer, ids: string[]): Promise<RawMessage[]> {
        return fetchMsgsByMsgId(this.service, target, ids);
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

    /** 按原生消息 ID 添加或移除 QQ 系统表情表态。 */
    async setMsgEmojiLikeById(
        target: Peer,
        { msgId, emojiId, like }: { msgId: string; emojiId: string; like: boolean },
    ): Promise<void> {
        if (typeof msgId !== "string" || msgId.trim() === "") {
            throw kernelError("缺少原生消息 ID", "INVALID_PARAM");
        }
        if (typeof emojiId !== "string" || !QQ_EMOJI_ID_PATTERN.test(emojiId)) {
            throw kernelError("表情 ID 必须是 QQ 系统表情索引的十进制字符串", "INVALID_PARAM");
        }

        const messages = await this.fetchMsgsByMsgId(target, [msgId]);
        const message = messages.find(
            (msg) =>
                msg.msgId === msgId &&
                msg.chatType === target.chatType &&
                msg.peerUid === target.peerUid,
        );
        if (message === undefined) {
            throw kernelError("会话中找不到指定消息", "NOT_FOUND");
        }

        const { msgSeq } = message;
        if (typeof msgSeq !== "string" || !MESSAGE_SEQ_PATTERN.test(msgSeq)) {
            throw kernelError("消息缺少可用的序号", "INVALID_STATE");
        }
        await this.setMsgEmojiLike(target, { msgSeq, emojiId, emojiType: "1", like });
    }

    /** 语音转文字（fetch_ptt_text）。 */
    async fetchPttText(msgId: string, target: Peer): Promise<string> {
        return fetchPttText(this.service, msgId, target);
    }

    /** 标记会话已读。 */
    async markRead(target: Peer): Promise<void> {
        const raw = await this.service.setMsgRead(target);
        unwrapResult("setMsgRead", raw);
    }

    /** 语音主动下载（get_record 本地未命中兜底，2026-09-08 B1）。 */
    async downloadPtt(msgId: string, target: Peer): Promise<PttElement> {
        return downloadPtt(this.service, msgId, target);
    }

    /** 发送输入状态（set_input_status；eventType=1 输入中，0 停止）。 */
    async setInputStatus(target: Peer, eventType: number): Promise<void> {
        await this.service.sendShowInputStatusReq(target.chatType, eventType, target.peerUid);
    }

    /** 戳一戳发送（send_friend/group_nudge；参数形状待探测校准，失败抛 UNKNOWN）。 */
    async sendNudge(target: Peer, opts: { receiverUid: string; callerUid: string }): Promise<void> {
        const param: NudgeParam = {
            receiverUid: opts.receiverUid,
            callerUid: opts.callerUid,
            ...(target.chatType === ChatType.GROUP ? { confId: target.peerUid } : {}),
        };
        try {
            checkLooseResult("sendNudge", await this.service.sendNudge(param));
        } catch (e) {
            if (isKernelError(e)) {
                throw e;
            }
            throw kernelError(`sendNudge 调用失败: ${errorMessage(e)}`, "UNKNOWN");
        }
    }

    /** 会话置顶（set_peer_pin；setContactLocalTop 参数待探测校准）。 */
    async setContactTop(target: Peer, isTop: boolean): Promise<void> {
        try {
            checkLooseResult(
                "setContactLocalTop",
                await this.service.setContactLocalTop(target, isTop),
            );
        } catch (e) {
            if (isKernelError(e)) {
                throw e;
            }
            throw kernelError(`setContactLocalTop 调用失败: ${errorMessage(e)}`, "UNKNOWN");
        }
    }

    /** 收藏表情列表（get_custom_face_url_list；queryFavEmojiByDesc 形状待校准）。 */
    async queryFavEmojis(): Promise<string[]> {
        let raw: unknown;
        try {
            raw = await this.service.queryFavEmojiByDesc("");
        } catch (e) {
            throw kernelError(`queryFavEmojiByDesc 调用失败: ${errorMessage(e)}`, "UNKNOWN");
        }
        checkLooseResult("queryFavEmojiByDesc", raw);
        if (!isRecord(raw)) {
            return [];
        }
        const list = raw["emojiInfoList"];
        if (!Array.isArray(list)) {
            return [];
        }
        return extractFavEmojiUrls(list);
    }

    /** 发送合并转发（send_group/private_forward_msg）。 */
    async sendForwardMessage(
        target: Peer,
        sourcePeer: Peer,
        srcMsgIds: string[],
    ): Promise<{ msgId: string }> {
        return sendForwardMessage(this.service, target, sourcePeer, srcMsgIds);
    }

    /** 获取合并转发内容（get_forward_msg；resId 取自 multiForwardMsgElement）。 */
    async fetchForwardMessage(peer: Peer, msgId: string): Promise<RawMessage[]> {
        return fetchForwardMessage(this.service, peer, msgId);
    }

    /** 单条转发（forward_group/friend_single_msg；srcMsgIds 源、dstPeer 目标）。 */
    async forwardSingleMessage(
        sourcePeer: Peer,
        srcMsgIds: string[],
        dstPeer: Peer,
    ): Promise<void> {
        return forwardSingleMessage(this.service, sourcePeer, srcMsgIds, dstPeer);
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
