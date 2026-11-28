import { registerShutdownHook } from "../../lifecycle/shutdown.js";
import { log } from "../../shared/boot-log.js";
import { getErrorMessage } from "../../shared/type-guards.js";
import { env, isEnvEnabled } from "../runtime/env.js";
import type { HostSessionLike, KernelLike, LoginResultLike } from "../runtime/types.js";
import { runSmokeTest } from "./smoke.js";

/** 收发消息冒烟自检（NAPUKETTO_SMOKE=1）：MsgBridge + MsgApi 真发/收一条。 */
export async function runSmokeIfEnabled(
    kernel: KernelLike,
    session: HostSessionLike,
    loginResult: LoginResultLike,
): Promise<void> {
    if (!isEnvEnabled(env.NAPUKETTO_SMOKE)) {
        return;
    }
    try {
        const ok = await runSmokeTest(kernel, session, loginResult);
        log(`bootstrap: 冒烟自检${ok ? "通过" : "未完全通过"}（见上文 smoke 日志）`);
    } catch (smokeErr) {
        log(`bootstrap: 冒烟自检异常: ${getErrorMessage(smokeErr)}`);
    }
}

/** 立即探测一次（NAPUKETTO_PROBE=1）：fallback / core 两处引导路径共用的探测原语。 */
export function probeOnce(session: HostSessionLike, filename?: string): void {
    try {
        const probe = session.probe(filename);
        log(
            `bootstrap: probe done, session=${probe.hasSession ? "ok" : "null"}, services=${probe.serviceCount}`,
        );
    } catch (e) {
        log(`bootstrap: probe error: ${getErrorMessage(e)}`);
    }
}

/** 显式启用的原生回调录制。 */
export function runListenerRecordingPhase(session: HostSessionLike): void {
    if (!isEnvEnabled(env.NAPUKETTO_LISTENER_RECORD)) {
        return;
    }
    try {
        const rec = session.recordListeners();
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
export function runProbePhase(session: HostSessionLike): void {
    if (!isEnvEnabled(env.NAPUKETTO_PROBE)) {
        return;
    }
    probeOnce(session);
    const lateProbeTimer = setTimeout(() => probeOnce(session, "napuketto-probe-late.json"), 35000);
    lateProbeTimer.unref();
    registerShutdownHook(() => clearTimeout(lateProbeTimer), "intake");
}
