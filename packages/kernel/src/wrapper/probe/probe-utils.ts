/**
 * 运行时反射探测基础工具（从 probe.ts 拆分，2026-08-08 FTA 优化）
 *
 * - listMethods：反射枚举对象原型链上的方法名（去重、去构造器）
 * - tryCall：安全调用方法拿返回值（失败记录错误，不中断探测）
 */

/** 反射枚举一个对象原型链上的方法名（去重、去构造器）。 */
export function listMethods(obj: unknown): string[] {
    if (obj === null || obj === undefined) {
        return [];
    }
    const names = new Set<string>();
    collectPrototypeNames(obj, names);
    collectOwnNames(obj, names);
    return [...names].sort();
}

/** 收集原型链上的属性名（到 Object/Function.prototype 为止，去构造器）。 */
function collectPrototypeNames(obj: unknown, names: Set<string>): void {
    let proto = Object.getPrototypeOf(obj);
    while (isProbeProto(proto)) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name !== "constructor") {
                names.add(name);
            }
        }
        proto = Object.getPrototypeOf(proto);
    }
}

/** 是否仍需遍历的原型（非 Object/Function.prototype 且非空）。 */
function isProbeProto(proto: object | null): proto is object {
    return proto !== null && proto !== Object.prototype && proto !== Function.prototype;
}

/** 收集自有属性名（去构造器）。 */
function collectOwnNames(obj: unknown, names: Set<string>): void {
    for (const name of Object.getOwnPropertyNames(obj)) {
        if (name !== "constructor") {
            names.add(name);
        }
    }
}

/** 安全调用：尝试调用方法拿返回值，失败记录错误（不中断探测）。 */
export function tryCall(
    obj: unknown,
    name: string,
): { ok: boolean; value?: unknown; error?: string } {
    try {
        const fn = (obj as Record<string, unknown>)[name];
        if (typeof fn !== "function") {
            return { ok: false, error: `not a function (typeof=${typeof fn})` };
        }
        const value = fn.call(obj);
        return { ok: true, value };
    } catch (e) {
        let message = String(e);
        if (e instanceof Error) {
            message = e.message;
        }
        return { ok: false, error: message };
    }
}

/** 服务 getter 判定（get*Service 命名约定）。 */
export function isServiceGetter(name: string): boolean {
    return name.startsWith("get") && name.endsWith("Service");
}

/** 探测 session 候选（来源标签 + 实例 + 非空服务计数）。 */
export interface ProbeSessionCandidate {
    source: string;
    session: unknown;
    /** 非空服务实例数（countNonNullServices 评分，主探测目标选取依据）。 */
    serviceNonNull: number;
}

/** 非空服务实例计数（逐个调用 get*Service 数非空返回；候选可用度评分）。
 *  自建宿主下 QQ 主 session 未被 init，get*Service 恒 null（2026-10-31 实测
 *  napuketto-probe-late.json），kernel 自建 session 服务可用——主目标按此评分选取。 */
export function countNonNullServices(session: unknown): number {
    if (session === null || session === undefined) {
        return 0;
    }
    let count = 0;
    for (const name of listMethods(session)) {
        if (!isServiceGetter(name)) {
            continue;
        }
        const call = tryCall(session, name);
        if (call.ok && call.value !== null && call.value !== undefined) {
            count += 1;
        }
    }
    return count;
}

/** 主探测目标选取：服务实例最多者优先，评分并列保持候选顺序（主 session 在前）。 */
export function pickPrimaryCandidate(candidates: ProbeSessionCandidate[]): ProbeSessionCandidate {
    let best = candidates[0];
    for (const candidate of candidates.slice(1)) {
        if (best !== undefined && candidate.serviceNonNull > best.serviceNonNull) {
            best = candidate;
        }
    }
    return best ?? { source: "own-create", session: null, serviceNonNull: 0 };
}
