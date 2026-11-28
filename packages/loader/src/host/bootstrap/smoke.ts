import { registerShutdownHook } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { getErrorMessage, getOwnProp } from "../../shared/type-guards.js";
import { env } from "../runtime/env.js";
import { forEachRawMessage } from "../runtime/state.js";
import type {
    GroupApiLike,
    HostSessionLike,
    KernelLike,
    LoginResultLike,
} from "../runtime/types.js";

/** 冒烟测试默认等待（毫秒）。 */
const SMOKE_SETTLE_MS = 5000;

/** 冒烟目标（c2c / group）。 */
interface SmokeTarget {
    kind: "c2c" | "group";
    uin: string;
}

/** 解析冒烟目标：NAPUKETTO_SMOKE_PEER（c2c:<uin> / group:<uin>），缺省发给自己。 */
function parseSmokeTarget(envPeer: string | undefined, selfUin: string): SmokeTarget {
    if (!envPeer) {
        return { kind: "c2c", uin: selfUin };
    }
    const [kind, uin = ""] = envPeer.split(":");
    if (kind === "group" && uin !== "") {
        return { kind: "group", uin };
    }
    if (kind === "c2c" && uin !== "") {
        return { kind: "c2c", uin };
    }
    return { kind: "c2c", uin: selfUin };
}

/** 提取消息纯文本（text 元素拼接，onRecvMsg 与落库核对共用）。 */
function extractTexts(kernel: KernelLike, msg: unknown): string {
    return kernel
        .toCanonicalElements(msg)
        .filter((el) => el.type === "text")
        .map((el) => el.text)
        .join("");
}

/** uin → uid（c2c 目标用；group 直接拿群号作 peerUid）。 */
async function resolvePeerUid(
    kernel: KernelLike,
    groupApi: GroupApiLike,
    target: SmokeTarget,
    login: LoginResultLike,
): Promise<{ chatType: number; peerUid: string }> {
    if (target.kind === "group") {
        return { chatType: kernel.ChatType.GROUP, peerUid: target.uin };
    }
    // c2c：目标是自己 → 直接用 selfUid（避免 uidToUin 往返）
    if (target.uin === login.uin) {
        return { chatType: kernel.ChatType.C2C, peerUid: login.uid };
    }
    const uidMap = await groupApi.uinToUid([target.uin]);
    const uid = uidMap.get(target.uin);
    if (!uid) {
        throw new Error(`uinToUid 解析失败: ${target.uin}`);
    }
    return { chatType: kernel.ChatType.C2C, peerUid: uid };
}

/**
 * 执行冒烟自检：注册 MsgBridge → 订阅 onRecvMsg → 发一条消息 → 拉历史核对。
 * @returns 是否全部通过（发送成功 + 收到事件 + 落库验证）
 */
export async function runSmokeTest(
    kernel: KernelLike,
    session: HostSessionLike,
    loginResult: LoginResultLike,
): Promise<boolean> {
    const services = session.createMessageServices();
    const unregisterShutdown = registerShutdownHook(() => services.dispose());
    try {
        return await checkMessageRoundTrip(kernel, services, loginResult);
    } finally {
        unregisterShutdown();
        services.dispose();
    }
}

async function checkMessageRoundTrip(
    kernel: KernelLike,
    services: ReturnType<HostSessionLike["createMessageServices"]>,
    loginResult: LoginResultLike,
): Promise<boolean> {
    const { channel, msgApi, groupApi } = services;
    const target = parseSmokeTarget(env.NAPUKETTO_SMOKE_PEER, loginResult.uin);

    // ② 订阅 onRecvMsg（接收方向验证；回调参数是消息数组，不是单条）
    let received = 0;
    let receivedText = "";
    channel.on("Msg/onRecvMsg", (msgs) => {
        forEachRawMessage(msgs, (m) => {
            received += 1;
            try {
                const texts = extractTexts(kernel, m);
                if (texts) {
                    receivedText = texts;
                }
            } catch (e) {
                log(`smoke: onRecvMsg 解析失败: ${getErrorMessage(e)}`);
            }
            log(
                `smoke: 📥 onRecvMsg 收到 #${received}（msgId=${getOwnProp(m, "msgId") ?? "?"} seq=${getOwnProp(m, "msgSeq") ?? "?"} text="${receivedText}"）`,
            );
        });
    });

    // ③ 发送方向：MsgApi.sendMessage
    const peer = await resolvePeerUid(kernel, groupApi, target, loginResult);
    const content = `Napuketto smoke test ${Date.now()}`;
    let sentMsgId = "";
    try {
        const { msgId } = await msgApi.sendMessage(peer, [{ type: "text", text: content }]);
        sentMsgId = msgId;
        log(`smoke: ✅ 发送成功 msgId=${msgId}（content="${content}"）`);
    } catch (e) {
        log(`smoke: ❌ 发送失败: ${getErrorMessage(e)}`);
    }

    // 等消息回显（自己发的消息 QQ 会通过 onRecvMsg 回传；不依赖则靠落库验证兜底）
    await new Promise((r) => setTimeout(r, SMOKE_SETTLE_MS));

    // ④ 落库验证：拉最近 10 条，确认刚发的消息在列表里
    let landed = false;
    try {
        const recent = await msgApi.fetchMessages(peer, { count: 10 });
        landed = recent.some(
            (m) => getOwnProp(m, "msgId") === sentMsgId || getOwnProp(m, "msgSeq") === sentMsgId,
        );
        log(
            `smoke: 落库验证: 最近 ${recent.length} 条${landed ? " ✅ 含刚发消息" : " ❌ 未找到（可能同步延迟）"}`,
        );
        if (!landed) {
            for (const m of recent.slice(0, 3)) {
                log(
                    `smoke:   最近消息 msgId=${getOwnProp(m, "msgId")} seq=${getOwnProp(m, "msgSeq")} text="${extractTexts(kernel, m)}"`,
                );
            }
        }
    } catch (e) {
        log(`smoke: 落库验证失败: ${getErrorMessage(e)}`);
    }

    const ok = sentMsgId !== "" && (received > 0 || landed);
    log(
        `smoke: ===== 冒烟${ok ? "✅ 通过" : "❌ 未完全通过"}（发送=${sentMsgId !== "" ? "OK" : "FAIL"}，收到事件=${received}，落库=${landed}）=====`,
    );
    return ok;
}
