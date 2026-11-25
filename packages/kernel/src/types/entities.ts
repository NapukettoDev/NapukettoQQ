/**
 * 实体类型层（运行时探测产物 + 公开资料作说明书，ADR-006）：接口签名是外部系统事实。
 * ⚠️ 跨平台空值契约：Windows 原生对象省略未命中的变体字段（undefined），Linux 3.2.x 则显式
 * 置 null（纯文本元素的 `picElement: null` 等），故可选字段都声明 `T | null`、读取必须用 `== null`。
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

/** 文本元素（at 用 atType + atNtUid/atUid 表达）。 */
export interface TextElement {
    content: string;
    atType?: number | null; // 1=全体 2=单人 4=我
    /**
     * 单人 at 目标的 **数字 UIN**（QQ 号字符串）。
     *
     * ⚠️ 不是 NT UID：把 `u_...` 写进本字段会被 wrapper 归零成 `"0"`。
     * 客户端原生元素里它是 atNtUid 的冗余镜像；`@全体` 缺省。
     */
    atUid?: string | null;
    /**
     * 单人 at 目标的 **NT UID**（`u_...`），QQNT 解析真实提及所依赖的字段；
     * 接收方向优先读它。`@全体` 实测为 `"all"`（atType=1）。
     */
    atNtUid?: string | null;
    /** at 目标 tinyId（原生元素可能携带；发送不需要）。 */
    atTinyId?: string | null;
}

/** 图片元素（发送时 picPath 必须；接收含 url）。 */
export interface PicElement {
    picPath?: string | null;
    picUrl?: string | null;
    picType?: number | null;
    picWidth?: number | null;
    picHeight?: number | null;
    md5?: string | null;
    fileName?: string | null;
    sourcePath?: string | null;
    thumbPath?: string | null;
    // 发送用完整字段（NapCat 式，实测：缺任一发送失败）
    md5HexStr?: string | null;
    fileSize?: string | null;
    original?: boolean | null;
    picSubType?: number | null;
    fileUuid?: string | null;
    fileSubId?: string | null;
    thumbFileSize?: number | null;
    summary?: string | null;
}

/** 语音元素（silk）。 */
export interface PttElement {
    filePath?: string | null;
    md5?: string | null;
    fileName?: string | null;
    duration?: number | null;
    /** 语音转文字结果（translatePtt2Text 异步写回）。 */
    text?: string | null;
    // 发送用完整字段（NapCat 式，实测：只给 filePath 会触发 wrapper
    // 内部 "Cannot convert undefined or null to object"（缺字段转换失败））
    md5HexStr?: string | null;
    fileSize?: string | null;
    formatType?: number | null;
    voiceType?: number | null;
    voiceChangeType?: number | null;
    canConvert2Text?: boolean | null;
    waveAmplitudes?: number[] | null;
    fileSubId?: string | null;
    playState?: number | null;
    autoConvertText?: number | null;
    storeID?: number | null;
    otherBusinessInfo?: { aiVoiceType: number } | null;
    // 收向完整字段（实测快照，getLatestDbMsgs 历史消息提取）
    fileId?: number | null;
    fileUuid?: string | null;
    translateStatus?: number | null;
    /** 传输状态：实测 2=收到已下载（数据库态，此时挪走本地文件调 downloadRichMedia 不重下）、4=自己发送已上传。 */
    transferStatus?: number | null;
    progress?: number | null;
    invalidState?: number | null;
    fileBizId?: unknown;
    import_rich_media_context?: unknown;
    isInApplicationDataPath?: boolean | null;
}

/** 表情元素。 */
export interface FaceElement {
    faceIndex: number;
    faceType?: number | null;
}

/** 回复元素（引用消息）。 */
export interface ReplyElement {
    replayMsgId: string;
    replayMsgSeq?: string | null;
    replayMsgTime?: string | null;
    senderUid?: string | null;
    senderUin?: string | null;
}

/** 视频缩略图在 thumbPath Map 中的 key（收向实测 Map<0, path>）。 */
export const VIDEO_THUMB_KEY = 0;

/** 视频元素（接收 + 发送）。 */
export interface VideoElement {
    filePath?: string | null;
    videoUrl?: string | null;
    fileName?: string | null;
    fileSize?: string | null;
    // 接收字段（收向实测快照，getLatestDbMsgs 历史视频消息）
    videoMd5?: string | null;
    thumbMd5?: string | null;
    /** 时长（秒）。 */
    fileTime?: number | null;
    thumbSize?: number | null;
    thumbWidth?: number | null;
    thumbHeight?: number | null;
    fileFormat?: number | null;
    busiType?: number | null;
    subBusiType?: number | null;
    /**
     * 缩略图路径。进程内收向实测 `Map<number, string>`（key 0 = Thumb 图片路径）；
     * 经 JSON 序列化（IPC 行协议等）后退化为平面对象（`{"0": path}`，且无规整的
     * 传输会丢成空对象 `{}`）。接收读取统一走 message-element 的
     * readVideoThumbPath（Map / 平面对象 / 字符串三形态均容忍）。
     * 发送时必须传真实 Map——JSON 序列化会丢成 `{}`，wrapper 转换失败。
     */
    thumbPath?: Map<number, string> | Record<string, string> | string | null;
    transferStatus?: number | null;
    progress?: number | null;
    invalidState?: number | null;
    fileUuid?: string | null;
    fileSubId?: string | null;
    fileBizId?: unknown;
    originVideoMd5?: string | null;
    import_rich_media_context?: unknown;
    sourceVideoCodecFormat?: number | null;
    storeID?: number | null;
    original?: boolean | null;
    videoFrom?: number | null;
    isInApplicationDataPath?: boolean | null;
    /** 发送补充字段（PIC/PTT 同款 md5 字段名）。 */
    md5HexStr?: string | null;
}

/** 文件元素。 */
export interface FileElement {
    filePath?: string | null;
    fileName?: string | null;
    fileSize?: string | null;
    fileUuid?: string | null;
    /** 文件 md5（录制实证：私聊文件消息必带；官方 Milky file_hash 为 TriSHA1，见 milky.md §0.8.6）。 */
    file10MMd5?: string | null;
    /** 文件 sha1（录制实证：接收侧为空，上传侧携带）。 */
    fileSha?: string | null;
    /** 文件 sha3（录制实证：接收侧为空）。 */
    fileSha3?: string | null;
    /** 过期时间（秒级 unix，录制实证）。 */
    expireTime?: number | null;
    /** 传输状态（录制实证）。 */
    transferStatus?: number | null;
    /** 文件子类型（录制实证：私聊离线文件 = 9）。 */
    subElementType?: number | null;
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
    operatorNick?: string | null;
    operatorRole?: string | null;
    isSelfOperate?: boolean | null;
    wording?: string | null;
}

/** AIOP 操作元素（戳一戳等，aioOpGrayTipElement）。 */
export interface TipAioOpGrayTipElement {
    operateType?: number | null;
    peerUid?: string | null;
    fromGrpCodeOfTmpChat?: string | null;
}

/** 群成员变动元素（groupElement 内的 TipGroupElement）。 */
export interface TipGroupElement {
    type?: TipGroupElementType | null;
    groupName?: string | null;
    memberUid?: string | null;
    memberNick?: string | null;
    memberRemark?: string | null;
    adminUid?: string | null;
    adminNick?: string | null;
    adminRemark?: string | null;
    shutUp?: {
        curTime?: string | null;
        duration?: string | null; // 禁言秒数
        admin?: {
            uid?: string | null;
            card?: string | null;
            name?: string | null;
            role?: number | null;
        } | null;
        member?: {
            uid?: string | null;
            card?: string | null;
            name?: string | null;
            role?: number | null;
        } | null;
    } | null;
}

/** 灰色提示元素（elementType=8，系统事件载体）。 */
export interface GrayTipElement {
    subElementType?: GrayTipSubType;
    revokeElement?: GrayTipRevokeElement | null;
    groupElement?: TipGroupElement | null;
    aioOpGrayTipElement?: TipAioOpGrayTipElement | null;
    xmlElement?: { busiId?: string; content?: string; templId?: string } | null;
    jsonGrayTipElement?: { busiId?: string; jsonStr?: string } | null;
}

/** 消息元素（RawMessage.elements 成员，elementType + 子元素互斥）。 */
export interface RawElement {
    elementType: number;
    elementId?: string;
    textElement?: TextElement | null;
    picElement?: PicElement | null;
    pttElement?: PttElement | null;
    faceElement?: FaceElement | null;
    replyElement?: ReplyElement | null;
    videoElement?: VideoElement | null;
    fileElement?: FileElement | null;
    grayTipElement?: GrayTipElement | null;
    /** ARK 卡片元素（elementType=10 ARK，小程序/分享卡片，B 站卡片实测）。bytesData 为卡片 JSON 字符串；其余字段待探测校准。 */
    arkElement?: { bytesData: string } | null;
    /** 合并转发元素（elementType=16 MULTI_FORWARD）。 */
    multiForwardMsgElement?: {
        resId: string;
        fileName: string;
        xmlContent: string;
    } | null;
}

/** QQ 消息（RawMessage，说明书参考字段，探测后校准）。 */
export interface RawMessage {
    msgId: string; // 雪花 ID
    msgSeq: string; // 消息序列号
    msgTime: string; // 时间戳
    msgRandom?: string | null;
    msgType: number;
    chatType: ChatType;
    peerUid: string; // 群号 / 用户 uid
    peerUin: string; // 群号 / 用户 QQ 号
    senderUid: string;
    senderUin: string;
    peerName: string;
    sendNickName: string;
    sendMemberName?: string | null;
    /** 发送状态（0=失败 1=发送中 2=成功 3=成功无seq）。onMsgInfoListUpdate 事件填充。 */
    sendStatus?: number | null;
    /** 发送方向（录制实证：文件消息 0=收到 2=自己发出；is_self 判据）。 */
    sendType?: number | null;
    elements: RawElement[];
    records?: RawMessage[] | null;
    guildId?: string | null;
    [key: string]: unknown;
}
