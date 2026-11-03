/**
 * adapter-reload.test.ts：onReload 热更新重建传输单测（2026-09-08 T7）。
 *
 * 文件型配置（非 seed）：start 后改写配置文件 → reload() → 断言
 * 传输重建（OB11 lifecycle enable 二次广播 + 退订重订阅；Satori
 * login-updated 离线/在线各一次）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBroadcaster } from "@napuketto/network";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ProtocolConfig } from "../../core/index.js";
import { NapukettoSatoriAdapter } from "../adapter.js";
import { satoriConfigSchema } from "../helper/index.js";

let tmpRoot = "";

function tempDir(): string {
    if (tmpRoot === "") {
        tmpRoot = mkdtempSync(join(tmpdir(), "napuketto-satori-reload-"));
    }
    return tmpRoot;
}

afterAll(() => {
    if (tmpRoot !== "") {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
});

/** 桩 SatoriApiOptions（构造期只持引用）。 */
function stubApiOptions(): Record<string, unknown> {
    return {
        msgApi: {},
        groupApi: {},
        groupNotifyApi: {},
        friendApi: {},
        profileApi: {},
        self: { uin: "10001", nickname: "测试号" },
        cacheDir: tempDir(),
    };
}

/** 捕获 emit 的 broadcaster。 */
function spyBroadcaster(): { broadcaster: EventBroadcaster; events: unknown[] } {
    const events: unknown[] = [];
    return {
        events,
        broadcaster: { emit: (e: unknown) => events.push(e) } as unknown as EventBroadcaster,
    };
}

describe("NapukettoSatoriAdapter.reload", () => {
    it("reload 重建传输：login-updated 离线+在线再广播，重订阅消息通道", async () => {
        const dir = tempDir();
        const cfgPath = join(dir, "satori.toml");
        writeFileSync(cfgPath, 'path = ""\n', "utf8");
        const { broadcaster, events } = spyBroadcaster();
        const onCalls = vi.fn(() => () => undefined);
        const adapter = new NapukettoSatoriAdapter({
            ...(stubApiOptions() as object),
            config: new ProtocolConfig({
                path: cfgPath,
                schema: satoriConfigSchema,
                defaults: satoriConfigSchema.parse({}),
            }),
            broadcaster,
            msgChannel: { on: onCalls } as unknown as ConstructorParameters<
                typeof NapukettoSatoriAdapter
            >[0]["msgChannel"],
        } as unknown as ConstructorParameters<typeof NapukettoSatoriAdapter>[0]);

        await adapter.start();
        const afterStart = events.length;
        expect(afterStart).toBeGreaterThan(0); // login-updated（在线）
        expect(onCalls).toHaveBeenCalledTimes(1);

        // 配置变更（path 变化）→ reload → 传输重建（离线 + 在线两次广播）
        writeFileSync(cfgPath, 'path = "/v1"\n', "utf8");
        await adapter.reload();
        expect(events.length).toBe(afterStart + 2);
        expect(onCalls).toHaveBeenCalledTimes(2); // 退订后重订阅

        await adapter.stop();
    });
});
