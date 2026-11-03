/**
 * 外部输入数组上界（2026-11-03 依赖审计整改）。
 *
 * 背景：zod 4.6.1 的 GHSA-mrhx-c7xc-m3w5（CWE-770，CVSS 7.5）只修了「带约束的
 * 集合校验时的内存放大」；`.max()` 上界属于业务侧的第二道防线——即便 zod 修好，
 * 单条 HTTP/WS 请求仍可以塞十万个合法 segment，让协议层逐项跑完整解析。故所有
 * 直接来自第三方调用（OneBot 11 HTTP / 反向 WS）的数组参数都在 schema 层限长。
 *
 * 取值按「真实业务上限的宽松倍数」：单条 QQ 消息不会超过几百个消息段；合并转发
 * 的节点数是批量操作，给到 500 仍远低于恶意输入量级。
 */
/** 单条消息的消息段上限（send_msg / send_group_msg / send_private_msg）。 */
export const MAX_MESSAGE_SEGMENTS = 200;

/** 合并转发节点上限（send_group_forward_msg / send_private_forward_msg）。 */
export const MAX_FORWARD_NODES = 500;

/** 批量文件操作的文件 id 上限（get_group_file_url / delete_group_file 等）。 */
export const MAX_FILE_IDS = 100;

/** 批量翻译的词条上限（translate_en2zh）。 */
export const MAX_TRANSLATE_WORDS = 2000;
