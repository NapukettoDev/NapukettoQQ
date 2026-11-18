/**
 * OB11 动作运行时：声明式动作工厂 + 响应信封 + 错误码映射 + 共享解析助手。
 *
 * 动作 = `{ name, schema, handle }` 声明对象，经 defineOb11Action 组装出
 * HTTP `handle`（校验失败 retcode=400）与 WS `websocketHandle`（1400 +
 * echo 透传）两个入口；执行骨架走 core runAction（zod safeParse → 执行 →
 * isKernelError 统一映射，映射表收拢为本文件 ob11ErrorCodeMap）。
 */
import { ChatType, kernelError, type Peer, type RawMessage } from "@napuketto/kernel";
import type { ZodType } from "zod";
import type { ErrorCodeMap } from "../../framework/index.js";
import { runAction } from "../../framework/index.js";
import type { MessageUnique } from "../helper/message-unique.js";
import { resolveMsgIdAndPeer } from "../helper/message-unique.js";

/** 校验失败 retcode：HTTP 入口。 */
const INVALID_RETCODE_HTTP = 400;
/** 校验失败 retcode：WS 入口。 */
const INVALID_RETCODE_WS = 1400;

/**
 * OB11 动作结果（retcode/status/data/message 信封 + WS echo）。
 *
 * 可辨识联合：`status` 判别，`ok` 分支 `retcode` 恒 0 且 `data` 非空、
 * `failed` 分支 `data` 恒 null。监听/传输层 `result.status === "ok"` 后
 * `result.data` 由编译器收窄为 T。字段名与旧版一致（echo 仍两侧可选）。
 */
export type ActionResult<T> =
    | {
          status: "ok";
          retcode: 0;
          data: T;
          message: "";
          echo?: unknown;
      }
    | {
          status: "failed";
          retcode: number;
          data: null;
          message: string;
          echo?: unknown;
      };

/** OB11 动作对象（工厂产出；HTTP 与 WS 共用同一校验执行骨架）。 */
export interface Ob11Action<TPayload = unknown, TReturn = unknown> {
    readonly name: string;
    readonly schema: ZodType<TPayload>;
    /** 校验并执行（HTTP 入口）。 */
    handle(payload: unknown): Promise<ActionResult<TReturn>>;
    /** 校验并执行（WS 入口，echo 透传）。 */
    websocketHandle(payload: unknown, echo?: unknown): Promise<ActionResult<TReturn>>;
}

/** OB11 错误码映射表（kernel KernelErrorCode → retcode；全部 OB11 动作共用）。 */
export const ob11ErrorCodeMap: ErrorCodeMap = {
    SEND_FAILED: 100,
    PERMISSION_DENIED: 101,
    NOT_FOUND: 102,
    TIMEOUT: 103,
    NOT_LOGIN: 104,
    INVALID_PARAM: 105,
    INVALID_STATE: 106,
    UNKNOWN: 999,
};

/** 声明式动作工厂：闭包依赖 + 统一信封与错误映射。 */
export function defineOb11Action<TPayload, TReturn>(spec: {
    name: string;
    schema: ZodType<TPayload>;
    handle: (payload: TPayload) => Promise<TReturn>;
}): Ob11Action<TPayload, TReturn> {
    const run = async (
        payload: unknown,
        invalidRetcode: number,
        echo?: unknown,
    ): Promise<ActionResult<TReturn>> => {
        const outcome = await runAction(
            {
                schema: spec.schema,
                handle: spec.handle,
                errorCodeMap: ob11ErrorCodeMap,
                invalidRetcode,
            },
            payload,
        );
        const result: ActionResult<TReturn> = outcome.ok
            ? { retcode: 0, status: "ok", data: outcome.data, message: "" }
            : { retcode: outcome.retcode, status: "failed", data: null, message: outcome.message };
        if (echo !== undefined) {
            result.echo = echo;
        }
        return result;
    };
    return {
        name: spec.name,
        schema: spec.schema,
        handle: (payload) => run(payload, INVALID_RETCODE_HTTP),
        websocketHandle: (payload, echo) => run(payload, INVALID_RETCODE_WS, echo),
    };
}

/** 解析单个 uin → uid（失败抛 KernelError INVALID_PARAM；多动作共用）。 */
export async function resolveUid(
    uin: string,
    uinToUid: (uins: string[]) => Promise<Map<string, string>>,
): Promise<string> {
    const uidMap = await uinToUid([uin]);
    const uid = uidMap.get(uin);
    if (uid === undefined) {
        throw kernelError(`用户 ${uin} 的 uid 解析失败`, "INVALID_PARAM");
    }
    return uid;
}

/** 解析目标 Peer（group_id 直通；user_id 经 uin→uid）。 */
export async function resolveTargetPeer(
    payload: { group_id?: number | undefined; user_id?: number | undefined },
    deps: { uinToUid: (uins: string[]) => Promise<Map<string, string>> },
    missingHint: string,
): Promise<Peer> {
    if (payload.group_id !== undefined) {
        return { chatType: ChatType.GROUP, peerUid: String(payload.group_id) };
    }
    if (payload.user_id !== undefined) {
        return {
            chatType: ChatType.C2C,
            peerUid: await resolveUid(String(payload.user_id), deps.uinToUid),
        };
    }
    throw kernelError(missingHint, "INVALID_PARAM");
}

/**
 * 按 message_id（OB11 int32 或 NT msgId）拉取单条消息。
 * 消息不存在/已被撤回 → 抛 KernelError NOT_FOUND。
 */
export async function fetchMsgById(
    messageId: number | string,
    messageUnique: MessageUnique,
    msgApi: { fetchMsgsByMsgId: (peer: Peer, msgIds: string[]) => Promise<RawMessage[]> },
): Promise<{ msg: RawMessage; peer: Peer; msgId: string }> {
    const { msgId, peer } = resolveMsgIdAndPeer(messageId, messageUnique);
    const msgs = await msgApi.fetchMsgsByMsgId(peer, [msgId]);
    const [msg] = msgs;
    if (msg === undefined) {
        throw kernelError(`消息 ${messageId} 不存在或已被撤回`, "NOT_FOUND");
    }
    return { msg, peer, msgId };
}
