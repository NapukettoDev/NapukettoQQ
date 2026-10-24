/**
 * 实体类型层（运行时探测产物 + 公开资料作说明书，ADR-006）
 *
 * ⚠️ 部分字段按公开资料（wrapper 外部契约）自研描述，待下一次进程内
 * 探测（probe.ts）校准——接口签名是外部系统事实，自研描述其形状。
 */

/** 会话类型（QQ wrapper 外部契约）。 */
export const ChatType = {
    C2C: 1, // 私聊
    GROUP: 2, // 群聊
    DISC: 3, // 讨论组
    GUILD: 4, // 频道
    C2C_TEMP: 100, // 临时会话（群内私聊）
} as const;
export type ChatType = (typeof ChatType)[keyof typeof ChatType];

/** 会话对象（peer 目标：群号 / 用户 uid）。 */
export interface Peer {
    chatType: ChatType;
    peerUid: string;
    guildId?: string;
}

/** 文本元素（at 用 atType + atUid 表达）。 */
export interface TextElement {
    content: string;
    atType?: number; // 1=全体 2=单人 4=我
    atUid?: string;
}

/** 图片元素（发送时 picPath 必须；接收含 url）。 */
export interface PicElement {
    picPath?: string;
    picUrl?: string;
    picType?: number;
    picWidth?: number;
    picHeight?: number;
    md5?: string;
    fileName?: string;
    sourcePath?: string;
    thumbPath?: string;
    // 发送用完整字段（NapCat 式，2026-08-11 实证：缺任一发送失败）
    md5HexStr?: string;
    fileSize?: string;
    original?: boolean;
    picSubType?: number;
    fileUuid?: string;
    fileSubId?: string;
    thumbFileSize?: number;
    summary?: string;
}

/** 语音元素（silk）。 */
export interface PttElement {
    filePath?: string;
    md5?: string;
    fileName?: string;
    duration?: number;
    /** 语音转文字结果（translatePtt2Text 异步写回）。 */
    text?: string;
    // 发送用完整字段（NapCat 式，2026-08-12 实证：只给 filePath 会触发 wrapper
    // 内部 "Cannot convert undefined or null to object"（缺字段转换失败））
    md5HexStr?: string;
    fileSize?: string;
    formatType?: number;
    voiceType?: number;
    voiceChangeType?: number;
    canConvert2Text?: boolean;
    waveAmplitudes?: number[];
    fileSubId?: string;
    playState?: number;
    autoConvertText?: number;
    storeID?: number;
    otherBusinessInfo?: { aiVoiceType: number };
    // 收向完整字段（2026-09-08 B1 实测快照，getLatestDbMsgs 历史消息提取）
    fileId?: number;
    fileUuid?: string;
    translateStatus?: number;
    /** 传输状态：实测 2=收到已下载（数据库态，此时挪走本地文件调 downloadRichMedia 不重下）、4=自己发送已上传。 */
    transferStatus?: number;
    progress?: number;
    invalidState?: number;
    fileBizId?: unknown;
    import_rich_media_context?: unknown;
    isInApplicationDataPath?: boolean | null;
}

/** 表情元素。 */
export interface FaceElement {
    faceIndex: number;
    faceType?: number;
}

/** 回复元素（引用消息）。 */
export interface ReplyElement {
    replayMsgId: string;
    replayMsgSeq?: string;
    replayMsgTime?: string;
    senderUid?: string;
    senderUin?: string;
}

/** 视频元素（接收 + 发送）。 */
export interface VideoElement {
    filePath?: string;
    videoUrl?: string;
    fileName?: string;
    fileSize?: string;
    // 接收字段（2026-10-17 收向实测快照，getLatestDbMsgs 历史视频消息）
    videoMd5?: string;
    thumbMd5?: string;
    /** 时长（秒）。 */
    fileTime?: number;
    thumbSize?: number;
    thumbWidth?: number;
    thumbHeight?: number;
    fileFormat?: number;
    busiType?: number;
    subBusiType?: number;
    /**
     * 缩略图路径。进程内收向实测 `Map<number, string>`（key 0 = Thumb 图片路径）；
     * 经 JSON 序列化（IPC 行协议等）后退化为平面对象（`{"0": path}`，且无规整的
     * 传输会丢成空对象 `{}`）。接收读取统一走 message-element 的
     * readVideoThumbPath（Map / 平面对象 / 字符串三形态均容忍）。
     * 发送时必须传真实 Map——JSON 序列化会丢成 `{}`，wrapper 转换失败。
     */
    thumbPath?: Map<number, string> | Record<string, string> | string;
    transferStatus?: number;
    progress?: number;
    invalidState?: number;
    fileUuid?: string;
    fileSubId?: string;
    fileBizId?: unknown;
    originVideoMd5?: string;
    import_rich_media_context?: unknown;
    sourceVideoCodecFormat?: number;
    storeID?: number;
    original?: boolean;
    videoFrom?: number;
    isInApplicationDataPath?: boolean | null;
    /** 发送补充字段（PIC/PTT 同款 md5 字段名）。 */
    md5HexStr?: string;
}

/** 文件元素。 */
export interface FileElement {
    filePath?: string;
    fileName?: string;
    fileSize?: string;
    fileUuid?: string;
}

/** 灰色提示子类型（系统事件类型，QQ wrapper 契约）。 */
export const GrayTipSubType = {
    REVOKE: 1, // 撤回
    PROCLAMATION: 2, // 群公告
    GROUP: 4, // 群成员变动（TipGroupElement）
    BUDDY: 5, // 好友变动
    FEED: 6,
    ESSENCE: 7, // 精华消息
    GROUP_NOTIFY: 8, // 群通知
    BUDDY_NOTIFY: 9,
    FILE: 10,
    JSON: 17,
} as const;
export type GrayTipSubType = (typeof GrayTipSubType)[keyof typeof GrayTipSubType];

/** 群成员变动类型（TipGroupElement.type）。 */
export const TipGroupElementType = {
    MEMBER_ADD: 1, // 入群
    DISBANDED: 2, // 群解散
    QUIT: 3, // 退群
    CREATED: 4, // 建群
    GROUP_NAME_MODIFIED: 5, // 群名修改
    BLOCK: 6,
    UNBLOCK: 7,
    SHUT_UP: 8, // 禁言
} as const;
export type TipGroupElementType = (typeof TipGroupElementType)[keyof typeof TipGroupElementType];

/** 撤回元素（revokeElement）。 */
export interface GrayTipRevokeElement {
    operatorUid: string;
    operatorNick?: string;
    operatorRole?: string;
    isSelfOperate?: boolean;
    wording?: string;
}

/** AIOP 操作元素（戳一戳等，aioOpGrayTipElement）。 */
export interface TipAioOpGrayTipElement {
    operateType?: number;
    peerUid?: string;
    fromGrpCodeOfTmpChat?: string;
}

/** 群成员变动元素（groupElement 内的 TipGroupElement）。 */
export interface TipGroupElement {
    type?: TipGroupElementType;
    groupName?: string;
    memberUid?: string;
    memberNick?: string;
    memberRemark?: string;
    adminUid?: string;
    adminNick?: string;
    adminRemark?: string;
    shutUp?: {
        curTime?: string;
        duration?: string; // 禁言秒数
        admin?: { uid?: string; card?: string; name?: string; role?: number };
        member?: { uid?: string; card?: string; name?: string; role?: number };
    };
}

/** 灰色提示元素（elementType=8，系统事件载体）。 */
export interface GrayTipElement {
    subElementType?: GrayTipSubType;
    revokeElement?: GrayTipRevokeElement;
    groupElement?: TipGroupElement;
    aioOpGrayTipElement?: TipAioOpGrayTipElement;
    xmlElement?: { busiId?: string; content?: string; templId?: string };
    jsonGrayTipElement?: { busiId?: string; jsonStr?: string };
}

/** 消息元素（RawMessage.elements 成员，elementType + 子元素互斥）。 */
export interface RawElement {
    elementType: number;
    elementId?: string;
    textElement?: TextElement;
    picElement?: PicElement;
    pttElement?: PttElement;
    faceElement?: FaceElement;
    replyElement?: ReplyElement;
    videoElement?: VideoElement;
    fileElement?: FileElement;
    grayTipElement?: GrayTipElement;
    /** 合并转发元素（elementType=16 MULTI_FORWARD）。 */
    multiForwardMsgElement?: {
        resId: string;
        fileName: string;
        xmlContent: string;
    };
}

/** QQ 消息（RawMessage，说明书参考字段，探测后校准）。 */
export interface RawMessage {
    msgId: string; // 雪花 ID
    msgSeq: string; // 消息序列号
    msgTime: string; // 时间戳
    msgRandom?: string;
    msgType: number;
    chatType: ChatType;
    peerUid: string; // 群号 / 用户 uid
    peerUin: string; // 群号 / 用户 QQ 号
    senderUid: string;
    senderUin: string;
    peerName: string;
    sendNickName: string;
    sendMemberName?: string;
    /** 发送状态（0=失败 1=发送中 2=成功 3=成功无seq）。onMsgInfoListUpdate 事件填充。 */
    sendStatus?: number;
    elements: RawElement[];
    records?: RawMessage[];
    guildId?: string;
    [key: string]: unknown;
}
