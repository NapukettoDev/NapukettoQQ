/**
 * Milky 收链路边界异步回填（自 adapter.ts 拆分）
 *
 * 翻译函数保持纯函数：uid→uin 批量转换、群实体（getGroupInfo / getGroupMember
 * 缓存优先）等翻译前的异步查询在此完成，结果经 ctx 注入翻译。查询全部
 * fail-soft，不阻塞事件上报。
 */
import type { CanonicalElement, RawMessage } from "@napuketto/kernel";
import { ChatType } from "@napuketto/kernel";
import type { MilkyApi } from "./api.js";
import type { ReceiveTranslateContext } from "./helper/event/translate.js";
import { toGroupEntity, toGroupMemberEntity } from "./helper/message/entities.js";

/** 回填器装配参数（api 由 adapter 注入）。 */
export interface MilkyEnrichmentDeps {
    api: MilkyApi;
}

/** Milky 收链路异步回填器。 */
export class MilkyEnrichment {
    private readonly api: MilkyApi;

    constructor(deps: MilkyEnrichmentDeps) {
        this.api = deps.api;
    }

    /** uid 批量 → uin（空集/失败返回 undefined 语义：调用方用空 Map）。 */
    resolveUidToUin(uids: string[]): Promise<Map<string, string> | undefined> {
        const unique = [...new Set(uids.filter((uid) => uid !== ""))];
        if (unique.length === 0) {
            return Promise.resolve(undefined);
        }
        return this.api.uidToUin(unique).catch((err) => {
            this.api.logger?.warn(
                { count: unique.length, error: err instanceof Error ? err.message : String(err) },
                "milky: uid→uin 批量转换失败，事件退用 uid",
            );
            return undefined;
        });
    }

    /** at uid → uin 批量转换（mention.user_id 用；失败 mention 段跳过）。 */
    async fillMentionUids(
        elements: CanonicalElement[],
        ctx: ReceiveTranslateContext,
    ): Promise<void> {
        const atUids = elements
            .filter((el) => el.type === "at" && el.target !== "all")
            .map((el) => (el as { target: string }).target);
        if (atUids.length === 0) {
            return;
        }
        try {
            ctx.uidToUin = await this.api.uidToUin(atUids);
        } catch (err) {
            // 转换失败：mention 段跳过（warn 留痕）
            this.api.logger?.warn(
                { count: atUids.length, error: err instanceof Error ? err.message : String(err) },
                "milky: at uid→uin 失败，mention 段跳过",
            );
        }
    }

    /** 群场景实体回填（GroupCache 缓存优先，失败最小实体兜底）。 */
    async fillGroupEntities(msg: RawMessage, ctx: ReceiveTranslateContext): Promise<void> {
        if (msg.chatType !== ChatType.GROUP || this.api.groupCache === undefined) {
            return;
        }
        const [detail, member] = await Promise.all([
            this.api.groupCache.getGroupDetail(msg.peerUid).catch((err) => {
                this.api.logger?.warn(
                    {
                        group: msg.peerUid,
                        error: err instanceof Error ? err.message : String(err),
                    },
                    "milky: 群详情缓存读取失败，实体回填退化",
                );
                return undefined;
            }),
            this.api.groupCache.getMember(msg.peerUid, msg.senderUid).catch((err) => {
                this.api.logger?.debug(
                    {
                        group: msg.peerUid,
                        member: msg.senderUid,
                        error: err instanceof Error ? err.message : String(err),
                    },
                    "milky: 群成员缓存读取失败，实体回填退化",
                );
                return undefined;
            }),
        ]);
        ctx.groupEntity = toGroupEntity(detail, msg.peerUid);
        ctx.groupMemberEntity = toGroupMemberEntity(member, msg.peerUid, msg.senderUin);
    }
}
