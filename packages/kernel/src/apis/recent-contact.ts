/**
 * RecentContactApi：会话列表语义化 API（P2 批次二，get_peer_pins 数据源）
 *
 * 2026-10-31 实机探测确认 getRecentContactService 有 getRecentContactList /
 * setContactListTop 等方法；返回形状待探测校准（宽松提取）。
 * 置顶数据源：isTop 过滤（ChatType 区分 friend/group 场景）。
 */
import { isKernelError, kernelError } from "../infra/index.js";
import type {
    NodeIKernelRecentContactService,
    NodeIQQNTWrapperSession,
    RecentContact,
} from "../types/index.js";
import { ChatType } from "../types/index.js";
import { checkLooseResult } from "./result.js";

/** 会话列表拉取条数（覆盖置顶集合足够大；参数值待探测校准）。 */
const RECENT_CONTACT_FETCH_COUNT = 200;

/** 置顶会话（get_peer_pins 数据项）：peerUid 按 chatType 归 friend/group。 */
export interface PinnedContact {
    /** 会话 id（好友 = uid，群 = 群号）。 */
    peerUid: string;
    /** 场景：friend（C2C）/ group（GROUP）；temp 不产出。 */
    scene: "friend" | "group";
}

/** 会话列表 API：从 session 拿 recent contact service，包装成语义化方法。 */
export class RecentContactApi {
    private readonly service: NodeIKernelRecentContactService;

    constructor(session: NodeIQQNTWrapperSession) {
        const service =
            session.getRecentContactService() as unknown as NodeIKernelRecentContactService | null;
        if (service === null || service === undefined) {
            throw kernelError(
                "getRecentContactService() 返回空（session 未 init）",
                "INVALID_STATE",
            );
        }
        this.service = service;
    }

    /** 置顶会话列表（get_peer_pins；getRecentContactList 返回形状待探测校准）。 */
    async getPinnedContacts(): Promise<PinnedContact[]> {
        let raw: { result?: unknown; errMsg?: unknown };
        try {
            raw = (await this.service.getRecentContactList({
                count: RECENT_CONTACT_FETCH_COUNT,
            })) as typeof raw;
        } catch (e) {
            if (isKernelError(e)) {
                throw e;
            }
            throw kernelError(`getRecentContactList 调用失败: ${errMsgString(e)}`, "UNKNOWN");
        }
        checkLooseResult("getRecentContactList", raw);
        return extractPinnedContacts(raw);
    }
}

/** 从返回形状提取置顶会话（result 数组 / 顶层 contacts / 嵌套容器兼容，待校准）。 */
function extractPinnedContacts(raw: { result?: unknown }): PinnedContact[] {
    const candidates: unknown[] = [raw.result, raw];
    for (const container of [raw.result, raw]) {
        if (container === null || typeof container !== "object") {
            continue;
        }
        const rec = container as Record<string, unknown>;
        for (const key of ["contacts", "data", "result", "list"] as const) {
            candidates.push(rec[key]);
        }
    }
    for (const candidate of candidates) {
        if (!Array.isArray(candidate)) {
            continue;
        }
        return candidate.flatMap((item) => pinnedOf(item));
    }
    return [];
}

/** 单条会话 → 置顶项（isTop 为真且场景可判定才产出）。 */
function pinnedOf(item: unknown): PinnedContact[] {
    if (item === null || typeof item !== "object") {
        return [];
    }
    const contact = item as RecentContact;
    if (contact.isTop !== true || typeof contact.peerUid !== "string") {
        return [];
    }
    if (contact.chatType === ChatType.GROUP) {
        return [{ peerUid: contact.peerUid, scene: "group" }];
    }
    if (contact.chatType === ChatType.C2C) {
        return [{ peerUid: contact.peerUid, scene: "friend" }];
    }
    return [];
}

/** 未知异常 → 消息字符串。 */
function errMsgString(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
