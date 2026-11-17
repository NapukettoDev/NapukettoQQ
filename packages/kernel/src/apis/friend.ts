/**
 * FriendApi：好友语义化 API（ADR-009 统一错误语义）
 *
 * 内部解包原生返回：成功返回纯业务值，失败抛 KernelError。
 * 方法面（P2-4 + P2-11）：好友列表（uid + 昵称/备注）+ 好友请求
 * （getBuddyReq / approvalFriendRequest / setBuddyRemark / delBuddy /
 * getDoubtBuddyReq / approvalDoubtBuddyReq）。
 */
import { kernelError } from "../infra/index.js";
import type {
    BuddyCategory,
    BuddyReq,
    DoubtBuddyReq,
    NodeIKernelBuddyService,
    NodeIQQNTWrapperSession,
} from "../types/index.js";
import { requireKernelService } from "../utils/type-guards.js";
import { checkLooseResult, unwrap } from "./result.js";

/** 好友条目（uid + 昵称/备注，昵称由 buddy service 缓存补全）。 */
export interface Friend {
    uid: string;
    uin: string;
    nickname: string;
    remark: string;
}

/** 带分类的好友列表项（get_friends_with_category 返回）。 */
export interface FriendCategory {
    categoryId: number;
    categorySortId: number;
    categoryName: string;
    categoryMbCount: number;
    onlineCount: number;
    buddyList: Friend[];
}

/** 可疑好友申请（OB11 结构，get_doubt_friends_add_request 返回）。 */
export interface DoubtFriendRequestInfo {
    flag: string;
    /**
     * 申请人 QQ 号。uid 无法解析为数字 uin（如 `u_xxx` 且不在任何群）时**缺省**：
     * `Number("u_xxx")` 会产出 NaN，JSON 序列化后静默变成 null（下游 number 契约被
     * 击穿），所以这里宁可不给字段，也不给 NaN / 0 这类假值。
     */
    uin?: number;
    nick?: string;
    source?: string;
    reason?: string;
    msg?: string;
    group_code?: string;
    time?: string;
    type: "doubt";
}

/** FriendApi 构造选项。 */
export interface FriendApiOptions {
    /** uid→uin 转换器（通常注入 GroupApi.uidToUin）；缺省 uin 退化为 uid。 */
    uidToUin?: ((uids: string[]) => Promise<Map<string, string>>) | undefined;
}

/** 好友 API：从 session 拿 buddy service，包装成语义化方法。 */
export class FriendApi {
    private readonly service: NodeIKernelBuddyService;
    private readonly uidToUin: ((uids: string[]) => Promise<Map<string, string>>) | undefined;

    constructor(session: NodeIQQNTWrapperSession, opts: FriendApiOptions = {}) {
        this.service = requireKernelService(session.getBuddyService(), "getBuddyService", [
            "getBuddyListFromCache",
            "getBuddyNick",
        ]);
        this.uidToUin = opts.uidToUin;
    }

    /** 好友列表（分类拍平为 Friend[]；昵称/备注从 service 缓存读取）。 */
    async getFriendList(): Promise<Friend[]> {
        let categories: BuddyCategory[];
        try {
            categories = await this.service.getBuddyListFromCache(0);
        } catch {
            const raw = await this.service.getBuddyListV2("cli", true, 0);
            if (raw.result !== 0) {
                throw kernelError(`getBuddyListV2 失败: ${raw.errMsg}`, "UNKNOWN");
            }
            categories = raw.data;
        }
        // buddyList（明细,T10 实证）优先,buddyUids（旧描述字段）兜底
        const uids = categories.flatMap(
            (cat) => cat.buddyList?.map((b) => b.uid) ?? cat.buddyUids ?? [],
        );
        let uinMap = new Map<string, string>();
        if (this.uidToUin !== undefined) {
            uinMap = await this.uidToUin(uids);
        }
        const out: Friend[] = [];
        for (const uid of uids) {
            out.push({
                uid,
                uin: uinMap.get(uid) ?? uid,
                nickname: this.service.getBuddyNick(uid),
                remark: this.service.getBuddyRemark(uid),
            });
        }
        return out;
    }

    /** 带分类的好友列表（get_friends_with_category，分类保留）。 */
    async getFriendCategories(): Promise<FriendCategory[]> {
        const categories = await this.getBuddyCategories();
        const friendMap = new Map<string, Friend>();
        for (const friend of await this.getFriendList()) {
            friendMap.set(friend.uid, friend);
        }
        return categories.map((cat) => {
            const buddies: Friend[] = [];
            for (const uid of cat.buddyList?.map((b) => b.uid) ?? cat.buddyUids ?? []) {
                const friend = friendMap.get(uid);
                if (friend !== undefined) {
                    buddies.push(friend);
                }
            }
            return {
                categoryId: cat.categoryId,
                categorySortId: cat.categorySortId,
                categoryName: cat.categroyName,
                categoryMbCount: cat.categroyMbCount,
                onlineCount: cat.onlineCount,
                buddyList: buddies,
            };
        });
    }

    /** 原始分类（getBuddyListV2 / 缓存）。 */
    private async getBuddyCategories(): Promise<BuddyCategory[]> {
        try {
            return await this.service.getBuddyListFromCache(0);
        } catch {
            const raw = await this.service.getBuddyListV2("cli", true, 0);
            if (raw.result !== 0) {
                throw kernelError(`getBuddyListV2 失败: ${raw.errMsg}`, "UNKNOWN");
            }
            return raw.data;
        }
    }

    /** 判断是否好友。 */
    isBuddy(uid: string): boolean {
        return this.service.isBuddy(uid);
    }

    /** 好友申请列表（set_friend_add_request 应答前查找匹配项）。 */
    async getBuddyReqList(): Promise<BuddyReq[]> {
        const raw = await this.service.getBuddyReq();
        unwrap("getBuddyReq", raw.result, raw.errMsg);
        return raw.buddyReqs ?? [];
    }

    /** 应答好友申请（accept=true 同意；remark 由调用方另行 setFriendRemark）。 */
    async handleFriendRequest(notify: BuddyReq, accept: boolean): Promise<void> {
        await this.service.approvalFriendRequest({
            friendUid: notify.friendUid,
            reqTime: notify.reqTime,
            accept,
        });
    }

    /** 设置好友备注（void 语义乐观处理）。 */
    setFriendRemark(uid: string, remark: string): void {
        this.service.setBuddyRemark({ uid, remark });
    }

    /** 删除好友（tempBlock=拉黑，tempBothDel=双向删除）。 */
    async deleteFriend(uid: string, tempBlock = false, tempBothDel = false): Promise<void> {
        const res = await this.service.delBuddy({
            friendUid: uid,
            tempBlock,
            tempBothDel,
        });
        checkLooseResult("delBuddy", res);
    }

    /** 可疑好友申请列表（get_doubt_friends_add_request；uin 经 uidToUin 转换）。 */
    async getDoubtFriendRequest(count: number): Promise<DoubtFriendRequestInfo[]> {
        const reqId = String(Date.now());
        const raw = await this.service.getDoubtBuddyReq(reqId, count, "");
        unwrap("getDoubtBuddyReq", raw.result, raw.errMsg);
        const list: DoubtBuddyReq[] = raw.doubtList ?? [];
        let uinMap = new Map<string, string>();
        if (this.uidToUin !== undefined && list.length > 0) {
            uinMap = await this.uidToUin(list.map((item) => item.uid));
        }
        const out: DoubtFriendRequestInfo[] = [];
        for (const item of list) {
            out.push(this.toDoubtFriendRequestInfo(item, uinMap));
        }
        return out;
    }

    /** 单项转换：DoubtBuddyReq → OB11 结构（可选字段条件赋值，exactOptionalPropertyTypes）。 */
    private toDoubtFriendRequestInfo(
        item: DoubtBuddyReq,
        uinMap: Map<string, string>,
    ): DoubtFriendRequestInfo {
        return toDoubtFriendRequestInfo(item, uinMap);
    }

    /** 处理可疑好友申请（set_doubt_friends_add_request；uid=flag）。 */
    handleDoubtFriendRequest(uid: string): void {
        this.service.approvalDoubtBuddyReq(uid, "", "");
    }
}

/** 可选字段条件赋值（undefined 跳过，兼容 exactOptionalPropertyTypes）。 */
function assignOptional<K extends keyof DoubtFriendRequestInfo>(
    info: DoubtFriendRequestInfo,
    key: K,
    value: DoubtFriendRequestInfo[K] | undefined,
): void {
    if (value !== undefined) {
        info[key] = value;
    }
}

/**
 * uid → uin 数值（解析失败返回 undefined，绝不产出 NaN）。
 *
 * uid 形如 `u_xxx` 且群口径未命中时 `Number(uid)` 是 NaN；NaN 混进 number 契约后
 * 经 JSON.stringify 变 null。这里只接受正安全整数（QQ 号），其余交给调用方省略字段。
 */
function resolveDoubtUin(uid: string, uinMap: Map<string, string>): number | undefined {
    const value = Number(uinMap.get(uid) ?? uid);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 单项转换：DoubtBuddyReq → OB11 结构（导出供单测，friend.test.ts）。 */
export function toDoubtFriendRequestInfo(
    item: DoubtBuddyReq,
    uinMap: Map<string, string>,
): DoubtFriendRequestInfo {
    const info: DoubtFriendRequestInfo = {
        flag: item.uid,
        type: "doubt",
    };
    assignOptional(info, "uin", resolveDoubtUin(item.uid, uinMap));
    assignOptional(info, "nick", item.nick);
    assignOptional(info, "source", item.source);
    assignOptional(info, "reason", item.reason);
    assignOptional(info, "msg", item.msg);
    assignOptional(info, "group_code", item.groupCode);
    assignOptional(info, "time", item.reqTime);
    return info;
}
