/**
 * 富媒体发送契约值（从 `apis/msg.ts` 拆出，只抽常量不改值）
 *
 * PIC / PTT / VIDEO 的固定字段值均为实测调通的 wrapper 发送契约；发送方向固定，
 * 改值会破坏富媒体发送。`picType` 由 `image-meta.ts` 的 `resolvePicType` 按
 * MIME/扩展名映射，不在此硬编码。
 */

/** PIC 元素发送契约值。 */
export const PIC_SUB_TYPE = 0;
export const PIC_ORIGINAL = true;
export const PIC_THUMB_FILE_SIZE = 0;
/** 无法探测出正整数宽高时的占位值（不是有效尺寸，仅满足发送契约字段）。 */
export const PIC_FALLBACK_SIZE = 0;

/**
 * PTT 元素发送契约值（NapCat 同款发送契约值，未逐字段校准）。
 * silk v3 协议：下列固定值均为实测调通的 wrapper 发送契约（formatType / voiceType /
 * voiceChangeType / canConvert2Text / playState / autoConvertText / storeID /
 * otherBusinessInfo.aiVoiceType），只抽常量不改值——改值会破坏语音发送。
 */
export const PTT_FORMAT_TYPE = 1;
export const PTT_VOICE_TYPE = 1;
export const PTT_VOICE_CHANGE_TYPE = 0;
export const PTT_CAN_CONVERT_2_TEXT = true;
export const PTT_PLAY_STATE = 1;
export const PTT_AUTO_CONVERT_TEXT = 0;
export const PTT_STORE_ID = 0;
export const PTT_AI_VOICE_TYPE = 0;
/** 假波形数组（占位波形）：无真实振幅数据时发送的固定占位，silk v3 协议契约值。 */
export const PTT_WAVE_AMPLITUDES = [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17];

/**
 * VIDEO 元素发送契约值（2026-10-17 收向实测字段 + 发送实测调通）。
 *
 * 依据：历史视频消息 `getLatestDbMsgs` 的 videoElement 实测快照（fileFormat /
 * busiType / subBusiType / storeID / original / videoFrom / sourceVideoCodecFormat
 * 均为实测出现的取值）。2026-10-17 18:12 自建宿主实测调通：`sendMsg` 成功
 * （sendStatus 2/3，群内可播放）；关键坑是**缩略图目标路径必须用视频 md5**。
 */
export const VIDEO_FILE_FORMAT = 0;
export const VIDEO_BUSI_TYPE = 0;
export const VIDEO_SUB_BUSI_TYPE = 0;
export const VIDEO_STORE_ID = 1;
export const VIDEO_ORIGINAL = true;
export const VIDEO_FROM = 0;
export const VIDEO_SOURCE_CODEC_FORMAT = 0;
/** getRichMediaFilePathForGuild 的 downloadType：1 = 原文件，2 = 缩略图。 */
export const RICH_MEDIA_DOWNLOAD_TYPE_ORIGIN = 1;
export const RICH_MEDIA_DOWNLOAD_TYPE_THUMB = 2;
