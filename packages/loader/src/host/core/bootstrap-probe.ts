/**
 * bootstrap-probe.ts：引导尾部的可选观测相位（2026-11-25 从 bootstrap-core.ts 拆出）。
 *
 * 三个 env 驱动的旁路能力，全部**失败不阻塞引导**（只写 napuketto-boot.log）：
 *  - `NAPUKETTO_SMOKE=1`：收发消息冒烟自检（MsgBridge + MsgApi 真发/收一条）
 *  - `NAPUKETTO_PROBE=1`：立即探测内核服务面 + 35s 后晚探测（落盘 json）
 *  - `NAPUKETTO_LISTENER_RECORD=1`：万能监听器挂满候选服务并逐行落盘
 *
 * ⚠️ 时序硬约束：listener 录制必须先于 probe（probe 的 getMainSession 写回副作用
 * 会毒化 ctx.session，给录制器留下空壳主 session）——两个相位分开导出的原因。
 */
import { getErrorMessage } from "../../internal/type-guards.js";
import { registerShutdownHook } from "../../lifecycle/shutdown.js";
import { env, isEnvEnabled } from "../env.js";
import type { CoreContextLike, KernelLike, LoginResultLike } from "../types.js";
import { log } from "../util.js";
import { runSmokeTest } from "./smoke.js";

/** P2-1 收发消息冒烟自检（NAPUKETTO_SMOKE=1）：MsgBridge + MsgApi 真发/收一条。 */
export async function runSmokeIfEnabled(
    kernel: KernelLike,
    ctx: CoreContextLike,
    loginResult: LoginResultLike,
): Promise<void> {
    if (!isEnvEnabled(env.NAPUKETTO_SMOKE)) {
        return;
    }
    try {
        const ok = await runSmokeTest(kernel, ctx, loginResult);
        log(`bootstrap: 冒烟自检${ok ? "通过" : "未完全通过"}（见上文 smoke 日志）`);
    } catch (smokeErr) {
        log(`bootstrap: 冒烟自检异常: ${getErrorMessage(smokeErr)}`);
    }
}

/** 立即探测一次（NAPUKETTO_PROBE=1）：fallback / core 两处引导路径共用的探测原语。 */
export function probeOnce(kernel: KernelLike, ctx: CoreContextLike): void {
    if (!isEnvEnabled(env.NAPUKETTO_PROBE) || typeof kernel.probeRuntime !== "function") {
        return;
    }
    try {
        const probe = kernel.probeRuntime(ctx);
        log(
            `bootstrap: probe done, session=${probe.session ? "ok" : "null"}, services=${Object.keys(probe.services ?? {}).length}`,
        );
    } catch (e) {
        log(`bootstrap: probe error: ${getErrorMessage(e)}`);
    }
}

/**
 * listener 录制模式（NAPUKETTO_LISTENER_RECORD=1，批次三前置）：万能监听器挂满
 * 候选服务，回调逐行落盘 napuketto-listener-record.jsonl。
 * ⚠️ 必须先于 runProbePhase——probe 的 getMainSession 写回副作用会毒化
 * ctx.session（空壳主 session），录制器要先取服务。
 */
export function runListenerRecordingPhase(kernel: KernelLike, ctx: CoreContextLike): void {
    if (!isEnvEnabled(env.NAPUKETTO_LISTENER_RECORD)) {
        return;
    }
    if (typeof kernel.startListenerRecording !== "function") {
        log("bootstrap: listener-record 请求但 kernel 缺 startListenerRecording（kernel 过旧）");
        return;
    }
    try {
        const rec = kernel.startListenerRecording(ctx);
        const ok = Object.values(rec.registered).filter((r) => r.ok).length;
        const total = Object.keys(rec.registered).length;
        log(`bootstrap: listener-record 挂起 ${ok}/${total} 服务 → ${rec.file}`);
        for (const [name, r] of Object.entries(rec.registered)) {
            if (!r.ok) {
                log(`bootstrap: listener-record ${name} 未挂: ${r.error ?? "unknown"}`);
            }
        }
    } catch (e) {
        log(`bootstrap: listener-record error: ${getErrorMessage(e)}`);
    }
}

/** 探测模式（NAPUKETTO_PROBE=1）：立即探测 + 35s 后晚探测（napuketto-probe-late.json）。 */
export function runProbePhase(kernel: KernelLike, ctx: CoreContextLike): void {
    if (!isEnvEnabled(env.NAPUKETTO_PROBE)) {
        return;
    }
    probeOnce(kernel, ctx);
    const lateProbeTimer = setTimeout(() => {
        try {
            if (typeof kernel.probeRuntime !== "function") {
                return;
            }
            const late = kernel.probeRuntime(ctx, "napuketto-probe-late.json");
            log(
                `bootstrap: probe-late done, session=${late.session ? "ok" : "null"}, services=${Object.keys(late.services ?? {}).length}`,
            );
        } catch (e2) {
            log(`bootstrap: probe-late error: ${getErrorMessage(e2)}`);
        }
    }, 35000);
    // 晚探测定时器不阻塞进程自然退出
    lateProbeTimer.unref?.();
    registerShutdownHook(() => clearTimeout(lateProbeTimer), "intake");
}
