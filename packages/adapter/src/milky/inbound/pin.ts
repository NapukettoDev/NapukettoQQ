/**
 * Milky inbound 置顶域：RecentContact/onRecentContactListChangedVer2 →
 * peer_pin_change（topFlag 翻转检测，条目自带 chatType 判场景）；启动期
 * getPinnedContacts 播种基线（重启后首个取消置顶也能观测到翻转）。
 */
import type { RecentContact, RecentContactListChanged } from "@napuketto/kernel";
import { numericUin } from "../../shared/uid-uin.js";
import type { MilkyInboundBase } from "../api.js";
import { PinWatch, toPeerPinChangeData } from "../helper/event/peer-pin.js";
import type { PeerPinChangeData } from "../types.js";

interface PinPayload {
    chatType: number;
    peerUin: string;
    topFlag: number;
    topFlagTime: string | undefined;
    data: PeerPinChangeData;
}

/** 置顶域装配参数 = 管道依赖全集（api / broadcast / logger 按需取用）。 */
export type MilkyInboundPinDeps = MilkyInboundBase;

/** Milky 置顶域处理器（翻转检测 + 播种基线 + peer_pin_change 广播）。 */
export class MilkyInboundPin {
    private readonly deps: MilkyInboundPinDeps;
    /** peer_pin 翻转检测（启动期 getPinnedContacts 播种）。 */
    private readonly pinWatch = new PinWatch();

    constructor(deps: MilkyInboundPinDeps) {
        this.deps = deps;
    }

    /** 会话列表变更 → 翻转检测逐条处理（首见/未变/不支持场景静默跳过）。 */
    handleChanges(lists: unknown): void {
        const arr = Array.isArray(lists) ? lists : [lists];
        for (const list of arr) {
            for (const entry of changedListOf(list)) {
                this.handleEntry(entry);
            }
        }
    }

    /** 启动基线：置顶会话播种（失败补 debug 日志，不再静默）。 */
    seed(): void {
        void this.deps.api.recentContactApi
            .getPinnedContacts()
            .then((pins) => {
                this.pinWatch.seed(pins);
            })
            .catch((err: unknown) => {
                this.deps.logger?.debug({ err: String(err) }, "milky: 置顶基线播种失败（跳过）");
            });
    }

    /** 单个变更条目：翻译 + 翻转检测 + 广播。 */
    private handleEntry(entry: unknown): void {
        const payload = pinPayloadOf(entry);
        if (payload === null) {
            return;
        }
        if (!this.pinWatch.observe(payload.chatType, payload.peerUin, payload.topFlag)) {
            return;
        }
        this.deps.broadcast({
            time: secondsOf(payload.topFlagTime),
            self_id: Number(this.deps.api.self.uin),
            event_type: "peer_pin_change",
            data: payload.data,
        });
    }
}

/** 变更列表 → changedList 条目数组（形状不符 → 空）。 */
function changedListOf(list: unknown): readonly unknown[] {
    if (list === null || typeof list !== "object") {
        return [];
    }
    const changed = (list as RecentContactListChanged).changedList;
    return Array.isArray(changed) ? changed : [];
}

/** 变更条目 → 翻转检测输入（null = 条目不支持/缺置顶字段）。 */
function pinPayloadOf(entry: unknown): PinPayload | null {
    if (entry === null || typeof entry !== "object") {
        return null;
    }
    return pinPayloadFrom(entry as RecentContact);
}

function pinPayloadFrom(contact: RecentContact): PinPayload | null {
    const topFlag = contact.topFlag;
    const payload = toPeerPinChangeData(contact);
    if (topFlag === undefined || payload === null) {
        return null;
    }
    return {
        chatType: contact.chatType,
        peerUin: payload.peerUin,
        topFlag,
        topFlagTime: payload.topFlagTime,
        data: payload.data,
    };
}

/** 秒级时间戳归一（空/非法 → 当前时间；topFlagTime/msgTime 均为秒级字符串）。 */
export function secondsOf(raw: string | undefined): number {
    return numericUin(raw ?? null) ?? Math.floor(Date.now() / 1000);
}
