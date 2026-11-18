/**
 * 群精华协议层提取器（仅保留 sysmsg 732:1 protobuf 树字段提取）
 *
 * 数据源（milky.md §0.8.6 识别表，三轮录制实证）：
 *  - sysmsg 732:1 群精华设置：f1.f1=群号, f1.f8.f8.f1=msgSeq（extractEssenceSetSysMsg）；
 *    取消精华无独立 sysmsg。push 内无 sender/operator——milky 作即时快路径，
 *    onebot11 作加速触发器（事件字段要求完整，走列表 diff 补齐）。
 *  - Group/onGroupEssenceListChange（录制实证 payload 只有群号）→
 *    WebApi.getEssenceMsgList 全量列表 diff：新增/移除 + operator（add_digest_uin）
 *    + sender（sender_uin）回填，是双方共用的发射路径。
 *
 * 列表缓存 / 首帧基线抑制 / 串行 diff 同步器属 kernel 缓存层（ADR-008 / ADR-028），
 * 本文件只 re-export 供 adapter 内部沿用同一导入面；sysmsg wire 解码与识别留在 adapter。
 */
import { type SysMsgField, varintAt } from "./sysmsg.js";

export type {
    EssenceAddedItem,
    EssenceCacheEntry,
    EssenceDiffResult,
    EssenceListSyncDeps,
} from "@napuketto/kernel";
export { diffEssenceList, EssenceListSync, narrowEssenceGroupArg } from "@napuketto/kernel";

/** sysmsg 732:1 提取结果。 */
export interface EssenceSetSysMsg {
    groupCode: number;
    messageSeq: number;
}

/** sysmsg 732:1 → 群号 + msgSeq（识别表实证路径；任一缺失 → null）。 */
export function extractEssenceSetSysMsg(tree: readonly SysMsgField[]): EssenceSetSysMsg | null {
    const groupCode = varintAt(tree, [1, 1]);
    const messageSeq = varintAt(tree, [1, 8, 8, 1]);
    if (groupCode === null || messageSeq === null) {
        return null;
    }
    return { groupCode, messageSeq };
}
