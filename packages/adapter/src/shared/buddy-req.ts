/**
 * BuddyReq 防御收窄 + 可处理性过滤（OB11 / Milky 共用，issue #122）
 *
 * onBuddyReqChange 回调参数形状未经真实事件校准（wrapper 字符串证据仅有方法名），
 * 仅接受字段形状可用的对象；未知形状返回 null 由调用方打 raw 日志积累校准数据。
 *
 * 收窄之外还有一层「要不要推给下游」的判定：QQNT 在登录 / 重连 / 审批后会把**全部**
 * 历史申请整批重放，其中大部分是已读、已处理或自己发起的。不过滤的后果是下游自动
 * 同意 → 触发原生回调 → 再次整批重放，形成死循环。过滤字段按「存在且明确」才生效
 * （字段缺失一律放行）：这些字段名来自说明书参考，未实证，不能因缺字段就静默丢弃申请。
 */
import { type BuddyReq, isRecord } from "@napuketto/kernel";
import { toUnixSeconds } from "./raw-message.js";

/** `KMEINITIATORWAITPEERCONFIRM`：等对方确认中，仍属待处理（isDecide=true 也不丢）。 */
const REQ_TYPE_INITIATOR_WAIT_PEER_CONFIRM = 13;

/** 去重缓存上限（插入序淘汰最旧项，防长跑进程无界增长）。 */
const DEDUP_LIMIT = 512;

/** 好友申请项安全构造（reqTime/friendUid 必备；已知可选字段按类型拷贝）。 */
export function parseBuddyReqItem(item: unknown): BuddyReq | null {
    if (
        !isRecord(item) ||
        typeof item["reqTime"] !== "string" ||
        typeof item["friendUid"] !== "string"
    ) {
        return null;
    }
    const out: BuddyReq = { reqTime: item["reqTime"], friendUid: item["friendUid"] };
    // 其余字段（friendNick / words / isDecide / unreadNums …）原样保留：
    // 值类型仍是 unknown，索引签名不引入断言；过滤逻辑依赖这些未实证字段。
    for (const [key, value] of Object.entries(item)) {
        if (key !== "reqTime" && key !== "friendUid") {
            out[key] = value;
        }
    }
    return out;
}

/** BuddyReq 防御性收窄：仅接受字段形状可用的对象。 */
export function isBuddyReqLike(value: unknown): value is BuddyReq {
    return parseBuddyReqItem(value) !== null;
}

/** 数组逐项安全构造（任一项残缺 → null，整批不进翻译层）。 */
function parseBuddyReqList(list: unknown[]): BuddyReq[] | null {
    const out: BuddyReq[] = [];
    for (const item of list) {
        const parsed = parseBuddyReqItem(item);
        if (parsed === null) {
            return null;
        }
        out.push(parsed);
    }
    return out;
}

/**
 * onBuddyReqChange 回调参数 → BuddyReq 列表（防御性收窄）。
 * 已知候选形状：BuddyReq[] / { buddyReqs: BuddyReq[] }；其余返回 null。
 */
export function narrowBuddyReqs(arg: unknown): BuddyReq[] | null {
    if (Array.isArray(arg)) {
        return parseBuddyReqList(arg);
    }
    if (isRecord(arg)) {
        const reqs = arg["buddyReqs"];
        if (Array.isArray(reqs)) {
            return parseBuddyReqList(reqs);
        }
    }
    return null;
}

/**
 * 批级未读数（`{ buddyReqs, unreadNums }` 形状时取外层字段）。
 * 0 表示「整批没有未处理项」，调用方可整批短路；非有限数 / 缺失 → undefined（不下判断）。
 */
export function batchUnreadNums(arg: unknown): number | undefined {
    if (!isRecord(arg)) {
        return undefined;
    }
    const value = arg["unreadNums"];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 单条申请是否为「需要推给下游的实时待处理项」。
 *
 * 过滤项（字段存在且明确才生效）：
 *  - `isInitiator === true`：自己发起的申请，回调只作状态通知；
 *  - `isUnread === false`：已读（历史重放的主体）；
 *  - `unreadNums === 0`：该项没有未读；
 *  - `isDecide === true` 且 reqType ≠ 13：已处理完毕；
 *  - `reqTime` 早于启动基准：登录 / 重连时同步进来的历史积压。
 *
 * `reqTime` 缺失或非法（归一为 0）时放行——宁可多报不可错杀。
 */
export function isActionableBuddyReq(req: BuddyReq, baselineSec: number): boolean {
    if (req["isInitiator"] === true) {
        return false;
    }
    if (req["isUnread"] === false) {
        return false;
    }
    // 未读数 0：该条没有未读（原生字段可能是 number 也可能是数字串）。显式 isUnread=true
    // 的项不参与本条判定——宁可多报一条真实申请，也不因未实证字段误杀。
    const unreadNums = req["unreadNums"];
    if (req["isUnread"] !== true && unreadNums !== undefined && Number(unreadNums) === 0) {
        return false;
    }
    const decided = req["isDecide"] === true;
    if (decided && Number(req["reqType"]) !== REQ_TYPE_INITIATOR_WAIT_PEER_CONFIRM) {
        return false;
    }
    const reqTimeSec = toUnixSeconds(req.reqTime);
    return reqTimeSec === 0 || reqTimeSec >= baselineSec;
}

/** 批量过滤（纯函数，保持输入顺序）。 */
export function filterBuddyReqs(reqs: readonly BuddyReq[], baselineSec: number): BuddyReq[] {
    return reqs.filter((req) => isActionableBuddyReq(req, baselineSec));
}

/**
 * 好友申请去重（实例级，跨 `reloadTransports` 保留）。
 *
 * 同一申请在多次回调里重复出现（登录同步 + 增量推送 + 审批后重放）时只推一次；
 * 键 `${friendUid}:${reqTime}` 与 OB11 flag 口径一致。上限外的旧键按插入序淘汰
 * ——被淘汰的极旧申请即使再被重放，也会先被 `reqTime` 基准拦掉。
 */
export class BuddyReqDedup {
    private readonly seen = new Map<string, true>();
    private readonly limit: number;

    constructor(limit: number = DEDUP_LIMIT) {
        this.limit = limit;
    }

    /** 首次出现的申请返回 true（已登记）；重复项返回 false。 */
    claim(req: BuddyReq): boolean {
        const key = `${req.friendUid}:${req.reqTime}`;
        if (this.seen.has(key)) {
            return false;
        }
        this.seen.set(key, true);
        if (this.seen.size > this.limit) {
            const oldest = this.seen.keys().next();
            if (!oldest.done) {
                this.seen.delete(oldest.value);
            }
        }
        return true;
    }
}
