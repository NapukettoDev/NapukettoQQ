/**
 * Milky 适配器生命周期测试（adapter.ts 装配/启停/热更新）
 *
 * 锁定：enabled=false 空转（不订阅不起传输）、start 即监听（回归）、
 * start 幂等、stop 退订（通道不再派发）+ 关传输、reload 重建（enabled 切换生效）、
 * token 鉴权装配、广播路径（捕获 adapter 收到事件）。
 */
import { Server } from "node:http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { expectCacheTimerReleased } from "../../internal/__tests__/media-cache-timer.js";
import { type AdapterEnv, adapterEnv, cleanupEnvDirs, flushAsync, rawMsg } from "./test-support.js";

/** 已启动的环境（afterEach 统一 stop）。 */
const started: AdapterEnv[] = [];

afterEach(async () => {
    for (const env of started) {
        await env.adapter.stop().catch(() => undefined);
    }
    started.length = 0;
    vi.restoreAllMocks();
});

afterAll(async () => {
    await cleanupEnvDirs();
});

/** 从真实监听的 HTTP server 读取系统分配的端口。 */
function listeningUrl(server: unknown): string {
    const address = server instanceof Server ? server.address() : null;
    if (address === null || typeof address === "string") {
        throw new Error("Milky HTTP server 未监听 TCP");
    }
    return `http://127.0.0.1:${address.port}`;
}

describe("enabled=false 空转", () => {
    it("start 后：无传输监听且消息不产生事件", async () => {
        const listen = vi.spyOn(Server.prototype, "listen");
        const env = await adapterEnv({ config: { enabled: false } });
        started.push(env);
        await env.adapter.start();
        await env.msgCh.emit("Msg/onRecvMsg", [rawMsgOf(env)]);
        await flushAsync();
        expect(env.captures).toHaveLength(0);
        expect(listen).not.toHaveBeenCalled();
    });

    it("未启用时 start 走校准日志提示", async () => {
        const env = await adapterEnv({ config: { enabled: false } });
        started.push(env);
        await env.adapter.start();
        expect(env.logger.info).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining("未启用"),
        );
    });
});

describe("enabled=true 启动", () => {
    it("H-04: stop releases the unref media cache timer", async () => {
        const env = await adapterEnv();
        started.push(env);
        await expectCacheTimerReleased(
            () => env.adapter.start(),
            () => env.adapter.stop(),
        );
    });

    it("start 即监听：HTTP /api 动作可达（无需显式 open）", async () => {
        const listen = vi.spyOn(Server.prototype, "listen");
        const env = await adapterEnv();
        started.push(env);
        await env.adapter.start();
        const res = await fetch(`${listeningUrl(listen.mock.contexts[0])}/api/get_login_info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; data: { uin: number } };
        expect(body.status).toBe("ok");
        expect(body.data.uin).toBe(10000);
    });

    it("token 配置生效：无凭据 401，Bearer 头放行", async () => {
        const listen = vi.spyOn(Server.prototype, "listen");
        const env = await adapterEnv({ config: { token: "s3cret" } });
        started.push(env);
        await env.adapter.start();
        const url = `${listeningUrl(listen.mock.contexts[0])}/api/get_login_info`;
        const denied = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        expect(denied.status).toBe(401);
        const ok = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
            body: "{}",
        });
        expect(ok.status).toBe(200);
    });

    it("start 后消息派发产生事件（订阅链路已接）", async () => {
        const env = await adapterEnv();
        started.push(env);
        await env.adapter.start();
        await env.msgCh.emit("Msg/onRecvMsg", [rawMsgOf(env)]);
        await flushAsync();
        expect(env.captures).toHaveLength(1);
        const event = env.captures[0] as { event_type: string };
        expect(event.event_type).toBe("message_receive");
    });

    it("start 幂等：二次 start 不重复订阅（单条消息只广播一次）", async () => {
        const env = await adapterEnv();
        started.push(env);
        await env.adapter.start();
        await env.adapter.start();
        await env.msgCh.emit("Msg/onRecvMsg", [rawMsgOf(env)]);
        await flushAsync();
        expect(env.captures).toHaveLength(1);
    });

    it("webhook 配置：装配 HttpClient 并注册广播（数量 = adapters 含捕获面）", async () => {
        const env = await adapterEnv({
            config: { webhooks: ["http://127.0.0.1:9/hook"] },
        });
        started.push(env);
        await env.adapter.start();
        await env.msgCh.emit("Msg/onRecvMsg", [rawMsgOf(env)]);
        await flushAsync();
        // 捕获 adapter 与 webhook client 都收到事件（client 真发请求前 onError 吞错）
        expect(env.captures).toHaveLength(1);
    });
});

describe("stop / reload", () => {
    it("stop 后：通道派发不再产生事件（退订）且端口已关闭", async () => {
        const listen = vi.spyOn(Server.prototype, "listen");
        const env = await adapterEnv();
        started.push(env);
        await env.adapter.start();
        const server = listen.mock.contexts[0];
        expect(server).toBeInstanceOf(Server);
        expect(server).toHaveProperty("listening", true);
        await env.adapter.stop();
        await env.msgCh.emit("Msg/onRecvMsg", [rawMsgOf(env)]);
        await flushAsync();
        expect(env.captures).toHaveLength(0);
        expect(server).toHaveProperty("listening", false);
    });

    it("stop 幂等：未 start 直接 stop 不抛", async () => {
        const env = await adapterEnv({ config: { enabled: false } });
        await expect(env.adapter.stop()).resolves.toBeUndefined();
    });

    it("reload：enabled true→false 热更新后停止订阅（文件态配置）", async () => {
        const env = await adapterEnv({ configFile: true });
        started.push(env);
        await env.adapter.start();
        await env.config.save({ ...env.config.get(), enabled: false });
        await env.adapter.reload();
        await env.msgCh.emit("Msg/onRecvMsg", [rawMsgOf(env)]);
        await flushAsync();
        expect(env.captures).toHaveLength(0);
    });

    it("reload：enabled false→true 后恢复监听与订阅（文件态配置）", async () => {
        const listen = vi.spyOn(Server.prototype, "listen");
        const env = await adapterEnv({
            configFile: true,
            config: { enabled: false },
        });
        started.push(env);
        await env.adapter.start();
        await env.config.save({ ...env.config.get(), enabled: true });
        await env.adapter.reload();
        const res = await fetch(`${listeningUrl(listen.mock.contexts[0])}/api/get_login_info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(200);
        await env.msgCh.emit("Msg/onRecvMsg", [rawMsgOf(env)]);
        await flushAsync();
        expect(env.captures).toHaveLength(1);
    });

    it("reload：enabled 不变 → 重建后仍单份订阅（无重复广播）", async () => {
        const env = await adapterEnv();
        started.push(env);
        await env.adapter.start();
        await env.msgCh.emit("Msg/onRecvMsg", [rawMsgOf(env)]);
        await flushAsync();
        await env.adapter.reload();
        await env.msgCh.emit("Msg/onRecvMsg", [rawMsgOf(env)]);
        await flushAsync();
        expect(env.captures).toHaveLength(2);
    });
});

describe("动作注册表装配", () => {
    it("registry 64 动作齐（适配器公共只读面）", async () => {
        const env = await adapterEnv({});
        expect(env.adapter.registry.names).toHaveLength(64);
    });

    it("protocol 名 = milky", async () => {
        const env = await adapterEnv({});
        expect(env.adapter.protocol).toBe("milky");
    });
});

/** 默认群聊文本消息（发送者 20002 ≠ self 10000，正常产生 message_receive）。 */
function rawMsgOf(_env: AdapterEnv): ReturnType<typeof rawMsg> {
    return rawMsg();
}
