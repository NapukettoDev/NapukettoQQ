/**
 * 系统信息/状态动作测试：get_status / get_version_info / get_login_info /
 * get_robot_uin_range / can_send_image / can_send_record / clean_cache /
 * bot_exit / set_restart / set_online_status / set_diy_online_status /
 * translate_en2zh。
 *
 * 锁定行为：本地组装返回值、self/system 注入面（版本/清理回调/进程控制）、
 * 未配置回调 → INVALID_STATE（retcode 106）、在线状态缺省值与自定义状态映射、
 * 翻译词条透传与上限校验。
 */
import { describe, expect, it, vi } from "vitest";
import {
    GetLoginInfoAction,
    GetRobotUinRangeAction,
    GetStatusAction,
    GetVersionInfoAction,
    TranslateEn2ZhAction,
} from "../info.js";
import {
    BotExitAction,
    CanSendImageAction,
    CanSendRecordAction,
    CleanCacheAction,
    SetDiyOnlineStatusAction,
    SetOnlineStatusAction,
    SetRestartAction,
} from "../status.js";

describe("本地组装类动作", () => {
    it("get_status → { online: true, good: true }", async () => {
        const result = await new GetStatusAction().handle({});
        expect(result.data).toEqual({ online: true, good: true });
    });

    it("get_version_info → app_name/protocol_version 固定，app_version 注入", async () => {
        const result = await new GetVersionInfoAction({ appVersion: "9.9.9-test" } as never).handle(
            {},
        );
        expect(result.data).toEqual({
            app_name: "napuketto-qq",
            app_version: "9.9.9-test",
            protocol_version: "v11",
        });
    });

    it("get_login_info → self uin/nickname 注入", async () => {
        const result = await new GetLoginInfoAction({ uin: "10001", nickname: "测试号" }).handle(
            {},
        );
        expect(result.data).toEqual({ user_id: 10001, nickname: "测试号" });
    });

    it("get_robot_uin_range → 固定 min/max", async () => {
        const result = await new GetRobotUinRangeAction().handle({});
        expect(result.data).toEqual({ min: 10001, max: 4294967295 });
    });

    it("can_send_image / can_send_record → 恒 true", async () => {
        expect((await new CanSendImageAction().handle({})).data).toEqual({ yes: true });
        expect((await new CanSendRecordAction().handle({})).data).toEqual({ yes: true });
    });
});

describe("clean_cache / bot_exit / set_restart（回调注入）", () => {
    it("clean_cache 已配置 → 调用回调", async () => {
        const cleanCache = vi.fn(async () => undefined);
        const result = await new CleanCacheAction({ cleanCache } as never).handle({});
        expect(result.retcode).toBe(0);
        expect(cleanCache).toHaveBeenCalledTimes(1);
    });

    it("clean_cache 未配置 → retcode 106（INVALID_STATE）", async () => {
        const result = await new CleanCacheAction({} as never).handle({});
        expect(result.retcode).toBe(106);
        expect(result.message).toContain("clean_cache 未配置");
    });

    it("bot_exit 已配置 → 调用 exit", async () => {
        const exit = vi.fn(async () => undefined);
        const result = await new BotExitAction({ exit } as never).handle({});
        expect(result.retcode).toBe(0);
        expect(exit).toHaveBeenCalledTimes(1);
    });

    it("bot_exit 未配置 → retcode 106", async () => {
        expect((await new BotExitAction({} as never).handle({})).retcode).toBe(106);
    });

    it("set_restart → restart 优先；缺省退化为 exit", async () => {
        const exit = vi.fn(async () => undefined);
        const restart = vi.fn(async () => undefined);
        await new SetRestartAction({ exit, restart } as never).handle({});
        expect(restart).toHaveBeenCalledTimes(1);
        expect(exit).not.toHaveBeenCalled();
        // 只有 exit 时退化
        const exitOnly = vi.fn(async () => undefined);
        await new SetRestartAction({ exit: exitOnly } as never).handle({});
        expect(exitOnly).toHaveBeenCalledTimes(1);
    });

    it("set_restart 都未配置 → retcode 106", async () => {
        expect((await new SetRestartAction({} as never).handle({})).retcode).toBe(106);
    });
});

describe("set_online_status / set_diy_online_status", () => {
    it("全缺省 → status=10 / extStatus=0 / batteryStatus=0", async () => {
        const msgApi = { setOnlineStatus: vi.fn(async () => undefined) };
        const result = await new SetOnlineStatusAction(msgApi as never).handle({});
        expect(result.retcode).toBe(0);
        expect(msgApi.setOnlineStatus).toHaveBeenCalledWith({
            status: 10,
            extStatus: 0,
            batteryStatus: 0,
        });
    });

    it("显式字段透传", async () => {
        const msgApi = { setOnlineStatus: vi.fn(async () => undefined) };
        await new SetOnlineStatusAction(msgApi as never).handle({
            status: 40,
            ext_status: 1,
            battery_status: 88,
        });
        expect(msgApi.setOnlineStatus).toHaveBeenCalledWith({
            status: 40,
            extStatus: 1,
            batteryStatus: 88,
        });
    });

    it("set_diy_online_status → customStatus（face_id/face_type 缺省补空/1）", async () => {
        const msgApi = { setOnlineStatus: vi.fn(async () => undefined) };
        const result = await new SetDiyOnlineStatusAction(msgApi as never).handle({
            wording: "摸鱼中",
        });
        expect(result.retcode).toBe(0);
        expect(msgApi.setOnlineStatus).toHaveBeenCalledWith({
            status: 10,
            extStatus: 0,
            batteryStatus: 0,
            customStatus: { faceId: "", wording: "摸鱼中", faceType: "1" },
        });
    });

    it("set_diy_online_status face_id/face_type/status 显式传入", async () => {
        const msgApi = { setOnlineStatus: vi.fn(async () => undefined) };
        await new SetDiyOnlineStatusAction(msgApi as never).handle({
            status: 50,
            wording: "忙碌",
            face_id: "12",
            face_type: "2",
        });
        expect(msgApi.setOnlineStatus).toHaveBeenCalledWith({
            status: 50,
            extStatus: 0,
            batteryStatus: 0,
            customStatus: { faceId: "12", wording: "忙碌", faceType: "2" },
        });
    });

    it("set_diy_online_status 缺 wording → retcode 400", async () => {
        const action = new SetDiyOnlineStatusAction({
            setOnlineStatus: vi.fn(),
        } as never);
        expect((await action.handle({})).retcode).toBe(400);
    });
});

describe("translate_en2zh", () => {
    it("words 透传 → { words }", async () => {
        const richMediaApi = { translateWords: vi.fn(async () => ["你好", "世界"]) };
        const result = await new TranslateEn2ZhAction(richMediaApi as never).handle({
            words: ["hello", "world"],
        });
        expect(result.data).toEqual({ words: ["你好", "世界"] });
        expect(richMediaApi.translateWords).toHaveBeenCalledWith(["hello", "world"]);
    });

    it("词条超上限（2000）→ retcode 400", async () => {
        const action = new TranslateEn2ZhAction({ translateWords: vi.fn() } as never);
        const words = Array.from({ length: 2001 }, () => "a");
        expect((await action.handle({ words })).retcode).toBe(400);
    });
});
