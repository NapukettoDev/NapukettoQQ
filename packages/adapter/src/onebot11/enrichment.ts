/**
 * OB11 收链路边界异步回填（ADR-008，2026-11-14 自 adapter.ts 拆分）
 *
 * 翻译函数保持纯函数：uid→uin 批量转换、群发送者角色查询、sysmsg uid 解析、
 * 精华 message_id 反查等翻译前的异步查询在此完成，结果经 ctx 注入翻译。
 * 除 notice 路径（失败上抛 → 调用方丢弃整个事件，原语义）外查询均 fail-soft。
 */
import type { RawMessage } from "@napuketto/kernel";
import { ChatType, toCanonicalElements } from "@napuketto/kernel";
import type { AdapterLoggerLike } from "../core/shared/log.js";
import type { OneBotApi } from "./api/index.js";
import { collectReceiveNeeds, type ReceiveTranslateContext } from "./helper/index.js";
import type { SysMsgEnvelope, SysMsgField, SysMsgKindRuleOB11 } from "./helper/sysmsg.js";

/** 回填器装配参数（api / 校准日志由 adapter 注入）。 */
export interface Ob11EnrichmentDeps {
    api: OneBotApi;
    logger?: AdapterLoggerLike | undefined;
}

/** OB11 收链路异步回填器。 */
export class Ob11Enrichment {
    private readonly api: OneBotApi;
    private readonly calibLogger: AdapterLoggerLike | undefined;

    constructor(deps: Ob11EnrichmentDeps) {
        this.api = deps.api;
        this.calibLogger = deps.logger;
    }

    /** uid 批量 → uin（失败退空 Map：翻译层退化为 uid 数值，不阻塞请求上报）。 */
    async uidToUinMap(uids: string[]): Promise<Map<string, string>> {
        if (uids.length === 0) {
            return new Map();
        }
        try {
            return await this.api.uidToUin(uids);
        } catch {
            return new Map();
        }
    }

    /**
     * notice uid 批量转换（空集退空 Map）。失败上抛不吞：grayTip 解析宽容但
     * uid 查询炸掉时整个 notice 丢弃（与原 adapter 行为一致，调用方 catch）。
     */
    async noticeUidMap(uids: string[]): Promise<Map<string, string>> {
        if (uids.length === 0) {
            return new Map();
        }
        return this.api.uidToUin(uids);
    }

    /**
     * 消息事件翻译上下文（P2-19：接收方向 ID 转换）。
     * at uid → 一次批量 uidToUin；群消息另查发送者角色（GroupCache 缓存优先，
     * 失败回退缺省 member）；msgId → OB11 id 经 messageUnique 反查。
     */
    async messageContext(msg: RawMessage): Promise<ReceiveTranslateContext> {
        const { atUids } = collectReceiveNeeds(toCanonicalElements(msg));
        let uidToUin: Map<string, string> | undefined;
        if (atUids.length > 0) {
            try {
                uidToUin = await this.api.uidToUin(atUids);
            } catch {
                // uid 解析失败：at 原样（uid），不阻塞事件上报
            }
        }
        const senderRole =
            msg.chatType === ChatType.GROUP
                ? await this.api.groupMemberRole(msg.peerUid, msg.senderUid)
                : undefined;
        return {
            ...(uidToUin !== undefined ? { uidToUin } : {}),
            ...(senderRole !== undefined ? { senderRole } : {}),
            msgIdToOb11Id: (msgId) => this.api.messageUnique.getMessageId(msgId),
        };
    }

    /** sysmsg 规则的 uid→uin 解析器（collectUids 声明才批量转换；失败/缺省恒 0）。 */
    async sysMsgUinResolver(
        rule: SysMsgKindRuleOB11,
        tree: readonly SysMsgField[],
        env: SysMsgEnvelope,
    ): Promise<(uid: string) => number> {
        if (rule.collectUids === undefined) {
            return () => 0;
        }
        const uids = rule.collectUids(tree, env).filter((uid) => uid !== "");
        if (uids.length === 0) {
            return () => 0;
        }
        try {
            const map = await this.api.uidToUin(uids);
            return (uid: string) => Number(map.get(uid) ?? 0);
        } catch {
            return () => 0;
        }
    }

    /**
     * 精华 message_id 反查：msgSeq → 近段历史扫描（60 条，对齐 milky
     * resolveMsgIdBySeq fallback 层）→ MessageUnique.alloc 幂等分配（可被 get_msg
     * 反查的正确空间，对照 recall 的 msgSeq 错位）。未命中返回 null（跳过事件）。
     */
    async resolveEssenceMsgId(groupCode: string, seq: number): Promise<number | null> {
        const peer = { chatType: ChatType.GROUP, peerUid: groupCode };
        const msgs = await this.api.msgApi.fetchMessages(peer, { count: 60 }).catch(() => []);
        const hit = msgs.find((m) => Number(m.msgSeq) === seq);
        if (hit === undefined) {
            this.calibLogger?.warn(
                { group: groupCode, seq },
                "ob11: 精华 message_id 反查未命中（跳过事件）",
            );
            return null;
        }
        return this.api.messageUnique.alloc(hit.msgId, peer);
    }
}
