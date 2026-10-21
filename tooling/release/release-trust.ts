/**
 * release-trust.ts：npm 可信发布（OIDC）信任配置探测层。
 *
 * 背景：npm 的信任配置是**逐包**的，registry 只认「repository + workflow
 * 文件 + environment」三项 claim 与该包记录精确相符的那一条。更隐蔽的是 npm
 * 的**两天过期**规则：新建的信任配置必须在 2 天内完成首次成功发布才算验证
 * 通过，逾期即失效且不可编辑（只能 revoke 后重建）。
 *
 * 失败表现极具误导性：registry 对「没配」「配了但 claim 不符」「配了但已
 * 过期」一律回 404 `OIDC token exchange error - package not found`，npm CLI
 * 只在 verbose 日志里记一句，然后静默退回无凭证发布，最终只剩 ENEEDAUTH
 * `need auth`。发布链又在首个失败处中断，于是每轮发布只能撞出**一个**缺口。
 *
 * 本模块直接复刻 npm CLI 的换 token 请求（npm/lib/utils/oidc.js）：
 * 用 Actions 的 id_token 去换该包的发布 token。换到 = 配置可用；404 = 该包
 * 当前没有可用配置；其余状态视为探测本身的问题（不据此拦截发布）。
 * 探测只换 token、不发布，换到的 token 用完即弃，绝不落日志。
 */

/** 单次探测请求的超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 并发探测数：包少（本仓 7 个）也要给 registry 留余量。 */
const PROBE_CONCURRENCY = 4;

/** 单包探测结论。 */
export interface TrustProbeResult {
    /** 包名。 */
    name: string;
    /** ok = 换到 token；missing = 该包没有可用配置；error = 探测本身不确定。 */
    status: "ok" | "missing" | "error";
    /** 供人读的原因（registry 的 message 或异常信息），不含任何凭证。 */
    detail: string;
}

/** 把包名转成换 token 路径段（`@scope/name` → `@scope%2Fname`）。 */
export function escapePackageName(name: string): string {
    return name.replaceAll("/", "%2F");
}

/** 某包的 OIDC 换 token 端点。 */
export function exchangeUrl(registry: string, name: string): string {
    return `${registry}/-/npm/v1/oidc/token/exchange/package/${escapePackageName(name)}`;
}

/**
 * 取 Actions 的 id_token（只有 `permissions: id-token: write` 的 job 才会
 * 注入 `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN`）。
 *
 * audience 与 npm CLI 一致：`npm:<registry 主机名>`。取不到 token 时抛错，
 * 由调用方决定是拦截还是仅告警。
 */
export async function fetchGithubIdToken(
    registry: string,
    fetchImpl: typeof fetch = fetch,
): Promise<string> {
    const requestUrl = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
    const requestToken = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
    if (!requestUrl || !requestToken) {
        throw new Error(
            "缺少 ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN（job 未声明 id-token: write）",
        );
    }
    const endpoint = new URL(requestUrl);
    endpoint.searchParams.append("audience", `npm:${new URL(registry).hostname}`);
    const res = await fetchImpl(endpoint, {
        headers: {
            accept: "application/json",
            authorization: `Bearer ${requestToken}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`GitHub id_token 请求失败：HTTP ${res.status}`);
    }
    const json = (await res.json()) as { value?: unknown };
    if (typeof json.value !== "string" || json.value === "") {
        throw new Error("GitHub id_token 响应缺少 value");
    }
    return json.value;
}

/** 从 registry 的错误响应里取 message（拿不到就退回空串）。 */
async function readErrorMessage(res: Response): Promise<string> {
    try {
        const text = await res.text();
        const json = JSON.parse(text) as { message?: unknown };
        return typeof json.message === "string" ? json.message : "";
    } catch {
        return "";
    }
}

/**
 * 探测单包能否换到发布 token。
 *
 * 404 → `missing`：该包当前没有可用信任配置（没配 / claim 不符 / 已过期，
 * npm 侧三者同码）。其余非 2xx 或网络异常 → `error`：探测本身不确定，
 * 调用方不应据此拦截发布。响应里的 token 不返回、不打印。
 */
export async function probePackageTrust(
    idToken: string,
    registry: string,
    name: string,
    fetchImpl: typeof fetch = fetch,
): Promise<TrustProbeResult> {
    let res: Response;
    try {
        res = await fetchImpl(exchangeUrl(registry, name), {
            method: "POST",
            headers: {
                accept: "application/json",
                authorization: `Bearer ${idToken}`,
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { name, status: "error", detail: `请求异常：${message}` };
    }
    if (res.ok) {
        try {
            const json = (await res.json()) as { token?: unknown };
            if (typeof json.token === "string" && json.token !== "") {
                return { name, status: "ok", detail: "已换到 token" };
            }
            return { name, status: "error", detail: "交换响应缺少 token" };
        } catch {
            return { name, status: "error", detail: "交换响应无法解析" };
        }
    }
    const message = await readErrorMessage(res);
    if (res.status === 404) {
        return { name, status: "missing", detail: message || "HTTP 404" };
    }
    return {
        name,
        status: "error",
        detail: `HTTP ${res.status}${message === "" ? "" : `（${message}）`}`,
    };
}

/**
 * 并发探测一批包（保持输入顺序输出）。
 *
 * 用固定大小的工作池而不是 `Promise.all`：包多时避免一次打满 registry。
 */
export async function probeTrustConfigs(
    idToken: string,
    registry: string,
    names: readonly string[],
    fetchImpl: typeof fetch = fetch,
): Promise<TrustProbeResult[]> {
    const results = new Map<string, TrustProbeResult>();
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < names.length) {
            const name = names[next];
            next += 1;
            if (name === undefined) {
                continue;
            }
            results.set(name, await probePackageTrust(idToken, registry, name, fetchImpl));
        }
    };
    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, names.length) }, () =>
        worker(),
    );
    await Promise.all(workers);
    return names.flatMap((name) => {
        const result = results.get(name);
        return result === undefined ? [] : [result];
    });
}
