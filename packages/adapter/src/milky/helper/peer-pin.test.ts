/**
 * peer_pin 翻译单测（批次三；形状依据 2026-11-01 set_peer_pin 翻转实验录制）
 */
import { describe, expect, it } from "vitest";
import { PinWatch, pinScene, toPeerPinChangeData } from "./peer-pin.js";

describe("pinScene：chatType → message_scene", () => {
    it("群 = group，好友 = friend，影子(7)/其他 = null", () => {
        expect(pinScene(2)).toBe("group");
        expect(pinScene(1)).toBe("friend");
        expect(pinScene(7)).toBeNull();
        expect(pinScene(0)).toBeNull();
    });
});

describe("toPeerPinChangeData：变更条目 → 事件载荷", () => {
    it("群条目（peerUin 携带）→ group + peer_id + is_pinned", () => {
        const out = toPeerPinChangeData({
            chatType: 2,
            peerUin: "1101729931",
            peerUid: "1101729931",
            topFlag: 1,
            topFlagTime: "1793540269",
        });
        expect(out?.data).toEqual({
            message_scene: "group",
            peer_id: 1101729931,
            is_pinned: true,
        });
        expect(out?.topFlagTime).toBe("1793540269");
    });

    it("取消置顶 → is_pinned=false", () => {
        const out = toPeerPinChangeData({
            chatType: 2,
            peerUin: "1101729931",
            peerUid: "1101729931",
            topFlag: 0,
        });
        expect(out?.data.is_pinned).toBe(false);
    });

    it("群条目 peerUin 缺失 → peerUid（恰为群号）兜底", () => {
        const out = toPeerPinChangeData({
            chatType: 2,
            peerUid: "1101729931",
            topFlag: 1,
        });
        expect(out?.data.peer_id).toBe(1101729931);
    });

    it("好友条目 peerUin 缺失 → null（peerUid 是 uid 形不可用作 peer_id）", () => {
        const out = toPeerPinChangeData({
            chatType: 1,
            peerUid: "u_FRIENDUID",
            topFlag: 1,
        });
        expect(out).toBeNull();
    });

    it("无 topFlag / 影子条目 / peerUin 非数字 → null", () => {
        expect(toPeerPinChangeData({ chatType: 2, peerUin: "1", peerUid: "1" })).toBeNull();
        expect(
            toPeerPinChangeData({ chatType: 7, peerUin: "0", peerUid: "", topFlag: 1 }),
        ).toBeNull();
        expect(
            toPeerPinChangeData({ chatType: 2, peerUin: "abc", peerUid: "abc", topFlag: 1 }),
        ).toBeNull();
    });
});

describe("PinWatch：topFlag 翻转检测", () => {
    it("首见不广播；值变化 → true；回到原值 → true；未变 → false", () => {
        const watch = new PinWatch();
        expect(watch.observe(2, "1101729931", 1)).toBe(false); // 首见（基线建立）
        expect(watch.observe(2, "1101729931", 1)).toBe(false); // 未变（消息活动快照）
        expect(watch.observe(2, "1101729931", 0)).toBe(true); // 取消置顶
        expect(watch.observe(2, "1101729931", 1)).toBe(true); // 再置顶
        expect(watch.observe(2, "1101729931", 1)).toBe(false);
    });

    it("群号与好友 uin 数值重叠时按 chatType 分键", () => {
        const watch = new PinWatch();
        expect(watch.observe(2, "10001", 1)).toBe(false);
        expect(watch.observe(1, "10001", 0)).toBe(false); // 独立键
        expect(watch.observe(1, "10001", 1)).toBe(true);
    });

    it("seed 播种基线：播种后首个取消置顶即翻转", () => {
        const watch = new PinWatch();
        watch.seed([
            { peerUid: "1101729931", peerUin: "1101729931", scene: "group" },
            { peerUid: "u_F", peerUin: "10001", scene: "friend" },
            { peerUid: "u_X", scene: "group" }, // 无 peerUin：跳过
        ]);
        expect(watch.observe(2, "1101729931", 0)).toBe(true);
        expect(watch.observe(1, "10001", 1)).toBe(false);
        // 未播种会话首见仍不广播
        expect(watch.observe(2, "999", 1)).toBe(false);
    });
});
