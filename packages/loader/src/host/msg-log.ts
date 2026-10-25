/**
 * 控制台消息日志（从 protocols.ts 拆分，2026-08-08 FTA 优化）
 *
 * 收到消息打印到控制台（NapCat 同款）。独立订阅，不干扰 adapter 的 OB11 翻译广播；
 * 解析纯函数无副作用（ADR-008）。高频业务日志调用点直接传**纯字符串**（不传对象），
 * pino-pretty 天然单行渲染，避免对象属性多行展开刷屏；boot 文件日志保留（引导期诊断）。
 *
 * 格式（2026-08-07 用户定稿）：`loader | 接收 <- 群聊 [群124010257] [用户3054108135]： 内容`
 *  - 剥离群名/用户名，只保留 ID（横向精简）：群聊显示 [群uin] + [用户uin]，
 *    私聊只显示 [用户对端uin]（会话即用户，避免重复）
 *  - 前缀灰色（背景噪音）、群 ID 青色、用户 ID 绿色、内容默认色（视觉焦点）
 *  - 内容内换行补 4 空格缩进，避免多行文本顶格破坏队形
 *  - console 版带 ANSI（logger），boot 文件版纯文本（log），互不污染；
 *    IPC 模式 logger 落文件 JSON，写 plain（colored 仅终端用）
 */
import type { CanonicalElementLike, EventChannelLike, KernelLike, LoggerLike } from "./types.js";
import { errMsg, forEachRawMessage, log } from "./util.js";

/** 终端 ANSI 颜色（消息日志颜色分层，2026-08-07 用户定稿）。 */
const ANSI = {
    gray: "\u001b[90m",
    cyan: "\u001b[36m",
    green: "\u001b[32m",
    reset: "\u001b[0m",
} as const;

/** canonical 元素 → 日志占位文本。 */
function elementToText(el: CanonicalElementLike): string {
    if (el.type === "text") {
        return el.text ?? "";
    }
    if (el.type === "at") {
        return `@${el.display ?? (el.target === "all" ? "全体" : el.target)}`;
    }
    if (el.type === "file") {
        return `[文件${el.name ?? ""}]`;
    }
    if (el.type === "forward") {
        return "[合并转发]";
    }
    return `[${el.type}]`;
}

/** 渲染消息为单行文本（text 拼接，at/媒体元素转占位）。 */
function renderMessage(kernel: KernelLike, msg: unknown): string {
    let rendered = "";
    for (const el of kernel.toCanonicalElements(msg)) {
        rendered += elementToText(el);
    }
    return rendered === "" ? "[空消息/媒体]" : rendered;
}

/** 单条消息的日志渲染产物（plain 落文件 / colored 落终端 + 绑定过滤元数据）。 */
interface MessageLogLine {
    plain: string;
    colored: string;
    /** 是否群聊（绑定过滤只作用于群频道）。 */
    isGroup: boolean;
    /** 对端 uin（群号 / 私聊对端）。 */
    peerUin: string;
}

/** 原始消息 → 日志行（纯函数，无副作用）。 */
function formatMessageLog(kernel: KernelLike, msg: unknown): MessageLogLine {
    const raw = msg as { chatType?: unknown; peerUin?: unknown; senderUin?: unknown };
    const rendered = renderMessage(kernel, msg);
    const isGroup = raw.chatType === kernel.ChatType.GROUP;
    const kind = isGroup ? "群聊" : "私聊";
    const peerUin = String(raw.peerUin ?? "");
    const senderUin = String(raw.senderUin ?? (peerUin || "未知"));
    // 群聊：群 + 用户两个标签；私聊：会话即用户，只显示用户标签
    const plainTags = isGroup ? `[群${peerUin}] [用户${senderUin}]` : `[用户${senderUin}]`;
    const coloredTags = isGroup
        ? `${ANSI.cyan}[群${peerUin}]${ANSI.reset} ${ANSI.green}[用户${senderUin}]${ANSI.reset}`
        : `${ANSI.green}[用户${senderUin}]${ANSI.reset}`;
    // 内容内换行补缩进（4 空格），长文本/多行消息换行后不顶格
    const content = rendered.replace(/\n/g, "\n    ");
    return {
        plain: `接收 <- ${kind} ${plainTags}： ${content}`,
        colored: `${ANSI.gray}loader | 接收 <- ${kind}${ANSI.reset} ${coloredTags}： ${content}`,
        isGroup,
        peerUin,
    };
}

/**
 * 接收行绑定过滤 holder（2026-10-25 P1-7）：kurobot 适配器握手（hello_ack /
 * bindings_updated）后填充 current；[log].unboundReceive=false 时 setupMsgLogging
 * 消费——未绑定频道的群消息接收行不打（私聊无绑定概念，恒放行）。
 * null = 无绑定信息（kurobot 未启用/未握手），不过滤。
 */
export interface ReceiveLogFilter {
    current: ((peerUin: string, isGroup: boolean) => boolean) | null;
}

/**
 * 消息日志订阅（onRecvMsg 回调参数为消息数组——2026-08-07 运行时实证，遍历逐条打印）。
 * 返回退订函数（软重登重装配时清理旧订阅，2026-09-08）；通道返回面宽松
 * （EventChannelLike.on 返回 unknown），非函数时退化为 no-op。
 *
 * 2026-10-25 级别重分配：接收行 info → debug（运行状态无信息量的高频行；
 * 终端要看配 [log.levels] loader = "debug"）。
 */
export function setupMsgLogging(
    kernel: KernelLike,
    channel: EventChannelLike,
    logger: LoggerLike | undefined,
    colorize: boolean,
    receiveFilter?: ReceiveLogFilter,
): () => void {
    const off = channel.on("Msg/onRecvMsg", (msgs) => {
        forEachRawMessage(msgs, (m) => {
            try {
                const { plain, colored, isGroup, peerUin } = formatMessageLog(kernel, m);
                // 绑定过滤：holder 有判定且本条未绑定 → 整行不打（含 boot 文件行）
                if (receiveFilter?.current !== null && receiveFilter !== undefined) {
                    if (!receiveFilter.current(peerUin, isGroup)) {
                        return;
                    }
                }
                log(plain);
                // IPC 模式 logger 是纯文件 JSON 日志，落 plain 避免 ANSI 转义污染 JSON 行；
                // cli 终端保持彩色（colorize 由 kernel-services 按渲染决策传入）
                logger?.debug(colorize ? colored : plain);
            } catch (e) {
                const line2 = `接收消息（解析失败: ${errMsg(e)}）`;
                log(line2);
                logger?.warn(line2);
            }
        });
    });
    // 通道返回面宽松（on 返回 unknown）：非函数 = 无退订能力，退化 no-op
    return typeof off === "function"
        ? (off as () => void)
        : () => {
              // 无退订能力（理论不达：NTEventChannel.on 恒返回退订函数）
          };
}
