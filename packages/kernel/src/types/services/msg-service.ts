/**
 * NodeIKernelMsgService：消息服务接口面（自研描述，非移植）
 *
 * 依据：getMsgService() 运行时反射 + wrapper 外部契约（接口签名是 QQ 的外部事实，
 * 自研描述其形状，零复制实现）。
 * 只收录 apis/msg 当前需要的方法；其余 200+ 方法按需探测后补齐。
 */
import type {
    FaceElement,
    Peer,
    PicElement,
    PttElement,
    RawMessage,
    ReplyElement,
    TextElement,
    VideoElement,
} from "../entities.js";

/** 原生通用返回：result 非 0 即失败（errMsg 附原因）。 */
export interface GeneralCallResult {
    result: number;
    errMsg: string;
}

/** 消息元素类型枚举（QQ wrapper 外部契约，自研描述）。 */
export const ElementType = {
    UNKNOWN: 0,
    TEXT: 1,
    PIC: 2,
    FILE: 3,
    PTT: 4,
    VIDEO: 5,
    FACE: 6,
    REPLY: 7,
    GRAY_TIP: 8,
    WALLET: 9,
    ARK: 10,
    MFACE: 11,
    LIVE_GIFT: 12,
    STRUCT_LONG_MSG: 13,
    MARKDOWN: 14,
    GIPHY: 15,
    MULTI_FORWARD: 16,
    INLINE_KEYBOARD: 17,
    INTEXT_GIFT: 18,
    CALENDAR: 19,
} as const;
export type ElementType = (typeof ElementType)[keyof typeof ElementType];

/** 发送消息元素（session 发送用，elementType + 各子元素互斥）。 */
export interface SendMessageElement {
    elementType: ElementType;
    elementId?: string;
    textElement?: TextElement;
    faceElement?: FaceElement;
    replyElement?: ReplyElement;
    picElement?: PicElement;
    pttElement?: PttElement;
    videoElement?: VideoElement;
}

/** 消息服务：apis/msg 用到的核心方法面。 */
export interface NodeIKernelMsgService {
    addKernelMsgListener(listener: unknown): number;
    removeKernelMsgListener(listenerId: number): void;
    generateMsgUniqueId(chatType: number, time: string): string;
    sendMsg(
        msgId: string,
        peer: Peer,
        elements: SendMessageElement[],
        map: Map<number, unknown>,
    ): Promise<GeneralCallResult>;
    recallMsg(peer: Peer, msgIds: string[]): Promise<GeneralCallResult>;
    getMsgs(
        peer: Peer,
        msgId: string,
        count: number,
        queryOrder: boolean,
    ): Promise<GeneralCallResult & { msgList?: RawMessage[] }>;
    /** 按 msgId 批量拉取消息（get_msg / 精华消息 / ptt 转文字共用）。 */
    getMsgsByMsgId(
        peer: Peer,
        ids: string[],
    ): Promise<GeneralCallResult & { msgList?: RawMessage[] }>;
    /**
     * 富媒体主动下载（get_record 语音下载，2026-09-08 B1 实测：单参数对象，
     * resolve undefined——结果只能经重拉消息元素观察；参数残缺时静默 no-op 不抛错；
     * transferStatus=2 已下载态调用为 no-op，详见 kernel design.md §5）。
     */
    downloadRichMedia(param: {
        msgId: string;
        elemId: string;
        chatType: number;
        downloadType: number;
        thumbSize: number;
    }): Promise<void>;
    setMsgRead(peer: Peer): Promise<GeneralCallResult>;
    /** 消息表情表态（set_msg_emoji_like；setOrCancel=true 点赞，false 取消）。 */
    setMsgEmojiLikes(
        peer: Peer,
        msgSeq: string,
        emojiId: string,
        emojiType: string,
        setOrCancel: boolean,
    ): Promise<GeneralCallResult>;
    /** 语音转文字（fetch_ptt_text；异步转写，结果写回 pttElement.text）。 */
    translatePtt2Text(msgId: string, peer: Peer, msgElement: unknown): Promise<GeneralCallResult>;
    /** 输入状态（set_input_status；eventType=1 输入中，0 停止）。 */
    sendShowInputStatusReq(chatType: number, eventType: number, toUid: string): Promise<unknown>;
    /**
     * 富媒体文件目标路径（NapCat 式发送图片前置：md5+文件名 → QQ 内部 Ori/Thumb 路径）。
     * 返回纯文件名（相对 QQ 数据根），需配合 NodeQQNTWrapperUtil.copyFile 放置文件。
     */
    getRichMediaFilePathForGuild(req: {
        md5HexStr: string;
        fileName: string;
        elementType: number;
        elementSubType: number;
        thumbSize: number;
        needCreate: boolean;
        downloadType: number;
        file_uuid: string;
    }): string;
    /** 合并转发组装（send_group/private_forward_msg；返回 MULTI_FORWARD 元素）。 */
    buildMultiForwardMsg(req: {
        srcMsgIds: string[];
        srcContact: Peer;
    }): Promise<GeneralCallResult & { rspInfo?: { elements?: SendMessageElement[] } }>;
    /** 获取合并转发内容（get_forward_msg；resId 取自 multiForwardMsgElement）。 */
    getMultiMsg(
        peer: Peer,
        msgId: string,
        resId: string,
    ): Promise<GeneralCallResult & { msgList?: RawMessage[] }>;
    /** 单条转发（forward_group/friend_single_msg；msgIds 源、dstPeers 目标）。 */
    forwardMsg(
        msgIds: string[],
        peer: Peer,
        dstPeers: Peer[],
        commentElements: unknown,
    ): Promise<GeneralCallResult>;
    /** 设置在线状态（set_online_status；customStatus 为自定义状态）。 */
    setStatus(args: {
        status: number;
        extStatus: number;
        batteryStatus: number;
        customStatus?: {
            faceId: string;
            wording: string;
            faceType: string;
        };
    }): Promise<GeneralCallResult>;
}
