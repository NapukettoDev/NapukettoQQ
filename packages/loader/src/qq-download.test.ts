/**
 * qq-download.test.ts：QQ 官方安装包下载器单测（qq-download.ts，node:https mock）。
 *
 * vi.mock("node:https") 拦截 get；假响应用真实 PassThrough 流（statusCode/headers
 * 附加属性），pipe/finish 走真实流语义。node:fs 部分替身（statSync 可注入失败，
 * 其余透传）。覆盖：
 *  - 成功下载：sha256 计算 + 落盘完成态校验（文件非空）+ 目录自动创建
 *  - sha256 校验：无期望值恒 true、大小写不敏感、失败 → DownloadError + 清理
 *  - 无 URL（参数/env 都缺）→ DownloadError；NAPUTO_QQ_URL 兜底
 *  - normalizeDownloadUrl 统一生效（QQNTV2 → qqntv2，含 env 兜底路径）
 *  - HTTP 非 200 → DownloadError；302 重定向跟随 + 5 跳上限
 *  - 请求超时（setTimeout → destroy）→ DownloadError；连接错误 → 抛出
 *  - 流中错误（fileFailed → 不删半成品）；完成但文件为空/缺失 → 报错清理
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadError, downloadFile } from "./qq-download.js";

/** https.get mock 与 statSync 失败注入（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        /** 每次请求收到的 URL（顺序）。 */
        requestedUrls: [] as string[],
        /** 当前应答器（返回响应与可选请求句柄）。 */
        responder: null as
            | null
            | ((url: string) => {
                  res: PassThrough & { statusCode: number; headers: Record<string, string> };
                  req?: FakeReq;
                  /** 连接错误（延迟 emit，先于响应投递）。 */
                  error?: Error;
                  /** error 延迟毫秒（默认 nextTick；给 write 流 open 留时间用 10+）。 */
                  errorDelayMs?: number;
                  /** true = 不投递响应（测试手动触发 req 超时/错误）。 */
                  defer?: boolean;
              }),
        /** statSync 失败注入（true = 抛错，模拟完成但文件缺失）。 */
        statFail: false,
    };
});

/** 假请求对象（setTimeout 可手动触发 → destroy → error 事件）。 */
class FakeReq {
    timeoutCb: (() => void) | null = null;
    private errorHandler: ((err: Error) => void) | null = null;

    on(event: string, fn: (err: Error) => void): this {
        if (event === "error") {
            this.errorHandler = fn;
        }
        return this;
    }

    /** 与 node:http ClientRequest 同构：setTimeout(ms, cb)。 */
    setTimeout(ms: number, cb: () => void): this {
        void ms;
        this.timeoutCb = cb;
        return this;
    }

    destroy(err?: Error): this {
        if (err !== undefined) {
            this.errorHandler?.(err);
        }
        return this;
    }

    /** 手动派发 error（连接错误用例）。 */
    emitError(err: Error): void {
        this.errorHandler?.(err);
    }
}

vi.mock("node:https", () => ({
    get: vi.fn((url: string, _opts: unknown, cb: (res: unknown) => void) => {
        h.requestedUrls.push(url);
        const responder = h.responder;
        const fakeReq = new FakeReq();
        const built: {
            res: FakeResponse;
            req?: FakeReq;
            error?: Error;
            errorDelayMs?: number;
            defer?: boolean;
        } = responder
            ? responder(url)
            : {
                  res: Object.assign(new PassThrough(), {
                      statusCode: 200,
                      headers: {},
                  }) as FakeResponse,
              };
        const req = built.req ?? fakeReq;
        process.nextTick(() => {
            if (built.error !== undefined) {
                const emit = (): void => {
                    req.emitError(built.error as Error);
                };
                if (built.errorDelayMs !== undefined) {
                    setTimeout(emit, built.errorDelayMs);
                } else {
                    emit();
                }
                return;
            }
            if (!built.defer) {
                cb(built.res);
            }
            // defer=true：不投递响应（测试手动触发 req 超时/错误事件）
        });
        return req;
    }),
}));

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        statSync: (path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
            if (h.statFail) {
                throw new Error("ENOENT: stat 注入失败");
            }
            return actual.statSync(path, ...(rest as []));
        },
    };
});

/** 假响应体类型别名（statusCode/headers 附加属性）。 */
type FakeResponse = PassThrough & { statusCode: number; headers: Record<string, string> };

/** 推入当前应答器（每请求同一 fn，可按 URL 分支；支持 error/defer 注入）。 */
function respond(
    fn: (url: string) => {
        res: FakeResponse;
        req?: FakeReq;
        error?: Error;
        errorDelayMs?: number;
        defer?: boolean;
    },
): void {
    h.responder = (url) => fn(url);
}

/** 200 响应（可选重定向 location 与自定义 status）。 */
function okResponse(body: string, opts: { status?: number; location?: string } = {}): FakeResponse {
    const headers: Record<string, string> = {};
    if (opts.location !== undefined) {
        headers["location"] = opts.location;
    }
    const res = Object.assign(new PassThrough(), {
        statusCode: opts.status ?? 200,
        headers,
    }) as FakeResponse;
    process.nextTick(() => {
        res.write(body);
        res.end();
    });
    return res;
}

let tmpRoot = "";
let dest = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-download-test-"));
    dest = join(tmpRoot, "installer.exe");
    h.requestedUrls.length = 0;
    h.responder = null;
    h.statFail = false;
});

afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = "";
    }
});

/** body 的 sha256（期望值构造用）。 */
function sha256Of(body: string): string {
    return createHash("sha256").update(body).digest("hex");
}

describe("downloadFile 成功路径", () => {
    it("下载 + sha256 校验通过 → 返回实际 sha256 与 verified=true", async () => {
        const body = "MZ-fake-installer-body";
        respond(() => ({ res: okResponse(body) }));
        const result = await downloadFile({
            dest,
            url: "https://qqdl.gtimg.cn/qqfile/QQNT/a.exe",
            expectedSha256: sha256Of(body),
        });
        expect(result.sha256).toBe(sha256Of(body));
        expect(result.verified).toBe(true);
        expect(readFileSync(dest, "utf8")).toBe(body);
    });

    it("无期望 sha256 → verified=true（首次下载尚无参考值）", async () => {
        respond(() => ({ res: okResponse("body") }));
        const result = await downloadFile({ dest, url: "https://example.com/a.exe" });
        expect(result.verified).toBe(true);
        expect(result.sha256).toBe(sha256Of("body"));
    });

    it("期望值大小写不敏感比对（清单大写也能过）", async () => {
        const body = "payload";
        respond(() => ({ res: okResponse(body) }));
        const result = await downloadFile({
            dest,
            url: "https://example.com/a.exe",
            expectedSha256: sha256Of(body).toUpperCase(),
        });
        expect(result.verified).toBe(true);
    });

    it("目标目录不存在 → 自动创建（createWriteStream 不建目录）", async () => {
        const nested = join(tmpRoot, "a", "b", "out.bin");
        respond(() => ({ res: okResponse("x") }));
        const result = await downloadFile({ dest: nested, url: "https://example.com/a.exe" });
        expect(result.verified).toBe(true);
        expect(existsSync(nested)).toBe(true);
    });

    it("NAPUTO_QQ_URL 兜底（options.url 未传）", async () => {
        vi.stubEnv("NAPUTO_QQ_URL", "https://env.example.com/qq.exe");
        respond(() => ({ res: okResponse("env-body") }));
        await downloadFile({ dest });
        expect(h.requestedUrls[0]).toBe("https://env.example.com/qq.exe");
    });

    it("唯一出站口统一归一化：/QQNTV2/ 降小写（CDN 边缘 WAF 绕行）", async () => {
        respond(() => ({ res: okResponse("x") }));
        await downloadFile({ dest, url: "https://qqdl.gtimg.com/qqfile/QQNTV2/9.9.33/QQ.exe" });
        expect(h.requestedUrls[0]).toBe("https://qqdl.gtimg.com/qqfile/qqntv2/9.9.33/QQ.exe");
    });

    it("NAPUTO_QQ_URL 兜底路径同样归一化", async () => {
        vi.stubEnv("NAPUTO_QQ_URL", "https://cdn.example.com/QQNTV2/a.exe");
        respond(() => ({ res: okResponse("x") }));
        await downloadFile({ dest });
        expect(h.requestedUrls[0]).toBe("https://cdn.example.com/qqntv2/a.exe");
    });
});

describe("downloadFile 失败路径", () => {
    it("无 URL（参数/env 都缺）→ DownloadError 下载地址为空", async () => {
        delete process.env["NAPUTO_QQ_URL"];
        await expect(downloadFile({ dest })).rejects.toMatchObject({
            name: "DownloadError",
            message: expect.stringContaining("下载地址为空"),
        });
        expect(existsSync(dest)).toBe(false);
    });

    it("HTTP 404 → DownloadError（半成品清理）", async () => {
        respond(() => ({ res: okResponse("not found", { status: 404 }) }));
        await expect(
            downloadFile({ dest, url: "https://example.com/a.exe" }),
        ).rejects.toMatchObject({
            name: "DownloadError",
            message: expect.stringContaining("HTTP 404"),
        });
        expect(existsSync(dest)).toBe(false);
    });

    it("302 重定向跟随（新 URL 发起请求）", async () => {
        respond((url) => {
            if (url === "https://a.example.com/r") {
                return {
                    res: okResponse("", {
                        status: 302,
                        location: "https://b.example.com/real.exe",
                    }),
                };
            }
            return { res: okResponse("final-body") };
        });
        await downloadFile({ dest, url: "https://a.example.com/r" });
        expect(h.requestedUrls).toEqual([
            "https://a.example.com/r",
            "https://b.example.com/real.exe",
        ]);
        expect(readFileSync(dest, "utf8")).toBe("final-body");
    });

    it("重定向超过 5 跳 → DownloadError 重定向次数过多", async () => {
        let n = 0;
        respond((url) => {
            n += 1;
            void url;
            return {
                res: okResponse("", { status: 302, location: `https://a.example.com/hop${n}` }),
            };
        });
        await expect(
            downloadFile({ dest, url: "https://a.example.com/hop" }),
        ).rejects.toMatchObject({
            name: "DownloadError",
            message: expect.stringContaining("重定向次数过多"),
        });
    });

    it("请求超时（setTimeout 回调触发 destroy）→ DownloadError 下载超时", async () => {
        const req = new FakeReq();
        respond((url) => {
            void url;
            return {
                res: Object.assign(new PassThrough(), {
                    statusCode: 200,
                    headers: {},
                }) as FakeResponse,
                req,
                defer: true, // 响应不投递：模拟慢服务器（等待超时）
            };
        });
        const pending = downloadFile({ dest, url: "https://example.com/slow.exe", timeoutMs: 500 });
        // 等 write 流 open 完成（macrotask），避免 rm 与建文件竞态
        await new Promise((r) => setTimeout(r, 20));
        expect(req.timeoutCb).toBeTypeOf("function");
        req.timeoutCb?.();
        await expect(pending).rejects.toMatchObject({
            name: "DownloadError",
            message: expect.stringContaining("下载超时(500ms)"),
        });
        expect(existsSync(dest)).toBe(false);
    });

    it("连接错误（req error 事件先于响应）→ 抛出并清理", async () => {
        respond((url) => {
            void url;
            return {
                res: Object.assign(new PassThrough(), {
                    statusCode: 200,
                    headers: {},
                }) as FakeResponse,
                error: new Error("ECONNREFUSED"),
                errorDelayMs: 10,
            };
        });
        await expect(
            downloadFile({ dest, url: "https://example.com/refused.exe" }),
        ).rejects.toThrow("ECONNREFUSED");
        expect(existsSync(dest)).toBe(false);
    });

    it("流中错误（res error）→ fileFailed 不删半成品", async () => {
        respond(() => {
            const res = Object.assign(new PassThrough(), {
                statusCode: 200,
                headers: {},
            }) as FakeResponse;
            // macrotask 调度：响应先投递（nextTick cb），再写一半报错
            setTimeout(() => {
                res.write("partial");
                res.destroy(new Error("stream aborted"));
            }, 5);
            return { res };
        });
        await expect(downloadFile({ dest, url: "https://example.com/cut.exe" })).rejects.toThrow(
            "stream aborted",
        );
        // fileFailed=true：保留现场供诊断（下载器 catch 不清理）
        expect(existsSync(dest)).toBe(true);
    });

    it("完成但文件为空 → DownloadError（WSL 并发清理竞态兜底）", async () => {
        respond(() => ({ res: okResponse("") }));
        await expect(
            downloadFile({ dest, url: "https://example.com/empty.exe" }),
        ).rejects.toMatchObject({
            name: "DownloadError",
            message: expect.stringContaining("下载完成但文件为空"),
        });
        expect(existsSync(dest)).toBe(false);
    });

    it("完成但 statSync 失败 → DownloadError 下载完成但文件缺失", async () => {
        respond(() => ({ res: okResponse("content") }));
        h.statFail = true;
        await expect(
            downloadFile({ dest, url: "https://example.com/gone.exe" }),
        ).rejects.toMatchObject({
            name: "DownloadError",
            message: expect.stringContaining("下载完成但文件缺失"),
        });
    });
});

describe("DownloadError", () => {
    it("错误名标记（调用方可按 name 分支）", () => {
        const err = new DownloadError("x");
        expect(err.name).toBe("DownloadError");
        expect(err).toBeInstanceOf(Error);
    });
});
