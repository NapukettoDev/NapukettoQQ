/**
 * ipc-bootstrap.ts：IPC 模式装配（bootstrap-core 调用）。
 *
 * 职责：登录前创建登录期动作表（login.refreshQr 可达）+ 启动 stdin 服务端；
 * 登录后把 kernel 服务动作并入同一张表 + 事件通道转发（onAny → event 消息）。
 * 返回停止函数（进程退出时清理）。
 */

import { env, isEnvEnabled } from "../env.js";
import { isCallable } from "../type-guards.js";
import type { CoreLike, KernelServices } from "../types.js";
import { errMsg, log } from "../util.js";
import {
    createIpcActions,
    type IpcActionHandler,
    type IpcActionOptions,
    registerLoginRefreshAction,
} from "./ipc-actions.js";
import { sendEvent } from "./ipc-sender.js";

/** 订阅事件通道 → event 消息转发（事件名 "Service/method" 拆分）。 */
function forwardChannel(
    channel: KernelServices["channel"] | undefined,
    stops: Array<() => void>,
): void {
    if (channel === undefined || channel === null) {
        return;
    }
    if (typeof channel.onAny !== "function") {
        return;
    }
    const off = channel.onAny((event, ...args) => {
        const slash = event.indexOf("/");
        const service = slash >= 0 ? event.slice(0, slash) : event;
        const name = slash >= 0 ? event.slice(slash + 1) : "";
        sendEvent(service, name, args);
    });
    // 宽松返回面（EventChannelLike.onAny 返回 unknown）：是函数才收进停止列表
    if (isCallable(off)) {
        stops.push(off);
    }
}

/**
 * 登录期动作表：只含 login.refreshQr（依赖 core.refreshQr，不依赖 session 服务）。
 * bootstrap-core 在登录前用它启动 IPC 服务端——登录中前端即可刷新二维码。
 */
export function createIpcActionsForCore(core: CoreLike): Map<string, IpcActionHandler> {
    const actions = new Map<string, IpcActionHandler>();
    if (typeof core.refreshQr === "function") {
        registerLoginRefreshAction(actions, () => core.refreshQr?.() ?? false);
    }
    return actions;
}

/**
 * 把 kernel 服务动作并入共享动作表 + 事件通道转发（登录成功后调用）。
 * 返回停止函数（清理事件转发订阅；stdin 服务端由 bootstrap-core 独立管理）。
 *
 * 诊断动作默认不注册；`options.diagnostics` 缺省读 `NAPUKETTO_DIAG`（显式本地调试）。
 */
export function attachIpcServices(
    actions: Map<string, IpcActionHandler>,
    services: KernelServices,
    options: IpcActionOptions = {},
): () => void {
    // peerUin（QQ 号）→ uid 转换（kernel GroupApi.uinToUid，自研描述；
    // exactOptionalPropertyTypes：可选字段用条件展开，不显式赋 undefined）
    const groupApi = services.groupApi;
    // ⚠️ 必须 bind（2026-08-20 生产实修）：GroupApi.uinToUid 是**类方法**，
    // 摘成裸函数注入会丢 this → 方法内 `this.service.getUidByUins()` 抛
    // `Cannot read properties of undefined (reading 'service')`（读的是
    // undefined 的 service，即 this 为 undefined，不是原生服务缺失）。
    // 症状：私聊/临时会话发送必失败（群聊 peerUid 直通群号不走本函数，恰好躲过），
    // 且错误消息极具误导性。core/kernel-services.ts 注入 uidToUin 用的是箭头包装
    // （正确写法），此处漏了——注入 kernel 类方法一律 bind 或箭头包装。
    const uinToUid = groupApi.uinToUid?.bind(services.groupApi);
    const diagnostics = options.diagnostics ?? isEnvEnabled(env.NAPUTO_DIAG);
    if (diagnostics) {
        log("ipc: 诊断动作已启用（仅本地调试；diag.* 按方法 allowlist 执行）");
    }
    const full = createIpcActions(
        {
            msgApi: services.msgApi,
            groupApi: services.groupApi,
            groupCache: services.groupCache,
            friendApi: services.friendApi,
            self: services.self,
            session: services.session,
            engine: services.engine,
            util: services.util,
            ...(uinToUid !== undefined ? { uinToUid } : {}),
        },
        { diagnostics },
    );
    for (const [name, handler] of full) {
        actions.set(name, handler);
    }

    const stops: Array<() => void> = [];
    const stopForwarding = (): void => {
        for (const stop of stops) {
            try {
                stop();
            } catch (err) {
                log(`ipc-bootstrap: 事件通道退订失败: ${errMsg(err)}`);
            }
        }
        // 移除并入的动作表条目（软重登重装配清理，2026-09-08）：点分命名与
        // OB11 snake_case / login.refreshQr 不冲突；重装配在同表重挂前必先停旧
        for (const name of full.keys()) {
            actions.delete(name);
        }
    };
    try {
        forwardChannel(services.channel, stops);
        forwardChannel(services.groupChannel, stops);
        forwardChannel(services.friendChannel, stops);
        forwardChannel(services.recentContactChannel, stops);
        forwardChannel(services.loginChannel, stops);
    } catch (err) {
        stopForwarding();
        throw err;
    }
    return stopForwarding;
}
