/**
 * helper/ids.test.ts：Satori ID 构造单测（QQ 平台语义）。
 *
 * 锁定：toUser / toGroupChannel / toDirectChannel / toGuild 的可选字段
 * 写入规则（空串不写）、toLogin / toMinimalLogin 的 login 形状、
 * PLATFORM / ADAPTER / FEATURES 常量契约。
 */
import { describe, expect, it } from "vitest";
import {
    ADAPTER,
    FEATURES,
    PLATFORM,
    toDirectChannel,
    toGroupChannel,
    toGuild,
    toLogin,
    toMinimalLogin,
    toUser,
} from "../ids.js";

describe("常量契约", () => {
    it("PLATFORM / ADAPTER 固定值", () => {
        expect(PLATFORM).toBe("qq");
        expect(ADAPTER).toBe("napuketto");
    });

    it("FEATURES：群组平坦 + message.list 分页令牌", () => {
        expect(FEATURES).toContain("guild.plain");
        expect(FEATURES).toContain("message.list.from");
    });
});

describe("toUser", () => {
    it("只带 id：name / nick 不写", () => {
        expect(toUser("123")).toEqual({ id: "123" });
    });

    it("name 与 nick 都写（非空）", () => {
        expect(toUser("123", "名字", "昵称")).toEqual({ id: "123", name: "名字", nick: "昵称" });
    });

    it("空串 name / nick：不写字段", () => {
        expect(toUser("123", "", "")).toEqual({ id: "123" });
        expect(toUser("123", "名字", "")).toEqual({ id: "123", name: "名字" });
    });
});

describe("toGroupChannel", () => {
    it("群号频道：type=0（TEXT），数字入参转字符串", () => {
        expect(toGroupChannel(12345 as unknown as string)).toEqual({ id: "12345", type: 0 });
    });

    it("非空群名写入 name", () => {
        expect(toGroupChannel("10001", "测试群")).toEqual({ id: "10001", type: 0, name: "测试群" });
    });

    it("空群名：不写 name", () => {
        expect(toGroupChannel("10001", "")).toEqual({ id: "10001", type: 0 });
    });
});

describe("toDirectChannel", () => {
    it("私聊频道：type=1（DIRECT）", () => {
        expect(toDirectChannel("90001")).toEqual({ id: "90001", type: 1 });
    });

    it("非空名称写入 name", () => {
        expect(toDirectChannel("90001", "小明")).toEqual({ id: "90001", type: 1, name: "小明" });
    });
});

describe("toGuild", () => {
    it("只带群号", () => {
        expect(toGuild("10001")).toEqual({ id: "10001" });
    });

    it("群名与头像都写入", () => {
        expect(toGuild("10001", "群名", "http://a/img.png")).toEqual({
            id: "10001",
            name: "群名",
            avatar: "http://a/img.png",
        });
    });

    it("空串字段不写", () => {
        expect(toGuild("10001", "", "http://a/img.png")).toEqual({
            id: "10001",
            avatar: "http://a/img.png",
        });
    });
});

describe("toLogin", () => {
    it("在线：status=1，features 展开，user 带昵称", () => {
        const login = toLogin({ uin: "10001", nickname: "机器人" }, 7, true);
        expect(login).toEqual({
            sn: 7,
            platform: "qq",
            user: { id: "10001", name: "机器人" },
            status: 1,
            adapter: "napuketto",
            features: [...FEATURES],
        });
    });

    it("离线：status=0（login-updated 离线广播用）", () => {
        const login = toLogin({ uin: "10001", nickname: "" }, 1, false);
        expect(login.status).toBe(0);
        expect(login.user?.name).toBeUndefined(); // 空昵称不写
    });
});

describe("toMinimalLogin", () => {
    it("最小字段：无 features（规范；adapter 保留）", () => {
        expect(toMinimalLogin(3, "10001")).toEqual({
            sn: 3,
            platform: "qq",
            user: { id: "10001" },
            status: 1,
            adapter: "napuketto",
        });
    });
});
