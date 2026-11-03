/**
 * Milky sysmsg 识别表（批次三，2026-11-01；识别机制共享自 core/sysmsg.ts）
 *
 * 键 = 原生分发键 "msgType:subType"，规则产出事件 data 体（信封 time/self_id/
 * event_type 由适配器统一包装）。路径依据 = 三轮录制 wire bytes 全量解码
 * （milky.md §0.8.6 识别表；临时解码脚本 .napuketto/decode-sysmsg*.mjs 不入库）。
 *
 *  - 732:16 群消息表情回应：f1.f1=群号；f3.f2.f44.f1.f1={f1 变动值, f2.f1=msgSeq,
 *    f3={f1 faceId 字符串, f5: 1=添加/2=撤销, f3:1 仅添加时存在}}。
 *    operator 不在 push（f4=bot 自身 uid 占位）——user_id 省略。
 *  - 732:1 群精华设置：f1.f1=群号, f1.f8.f8.f1=msgSeq（路径提取共享自
 *    core/essence.ts extractEssenceSetSysMsg）；取消精华无独立 sysmsg
 *    （remove 走 onGroupEssenceListChange 列表 diff，core/essence.ts）。
 *  - 528:349/381/382 多端设备同步族：不广播。
 */
import { extractEssenceSetSysMsg } from "../../core/essence.js";
import {
    nodeAt,
    recognizeSysMsg as recognizeSysMsgCore,
    type SysMsgField,
    type SysMsgKindRule,
    type SysMsgRecognition,
    textOf,
    varintAt,
    varintOf,
} from "../../core/sysmsg.js";
import type { GroupEssenceMessageChangeData, GroupMessageReactionData } from "../types.js";

/** 数字串判别（faceId 实证为数字字符串）。 */
const NUMERIC_RE = /^\d+$/;

export type { SysMsgKindRule, SysMsgRecognition } from "../../core/sysmsg.js";

/** Milky 识别规则：data 体类型为各事件载荷联合（信封由适配器包装）。 */
export type SysMsgKindRuleMilky = SysMsgKindRule<unknown>;

/** 732:16 → group_message_reaction。 */
const REACTION_RULE: SysMsgKindRuleMilky = {
    kind: "group_message_reaction",
    extract: (tree) => reactionData(tree),
};

/** 路径提取：f1.f1=群号 + f3.f2.f44.f1.f1=回应明细（任一缺失 → null）。 */
function reactionData(tree: readonly SysMsgField[]): GroupMessageReactionData | null {
    const groupId = varintAt(tree, [1, 1]);
    const detail = nodeAt(tree, [3, 2, 44, 1, 1]);
    if (groupId === null || detail === null) {
        return null;
    }
    return reactionDetail(groupId, detail);
}

/** 明细提取：f2.f1=msgSeq + f3=face 块（任一缺失 → null）。 */
function reactionDetail(
    groupId: number,
    detail: readonly SysMsgField[],
): GroupMessageReactionData | null {
    const msgSeq = varintAt(detail, [2, 1]);
    const face = nodeAt(detail, [3]);
    if (msgSeq === null || face === null) {
        return null;
    }
    return reactionFace(groupId, msgSeq, face);
}

/** face 块提取：faceId 实证为数字字符串（"76"/"124"…）；f5 双判据（f3 仅添加时存在）。 */
function reactionFace(
    groupId: number,
    msgSeq: number,
    face: readonly SysMsgField[],
): GroupMessageReactionData | null {
    const isAdd = reactionIsAdd(face);
    const faceId = reactionFaceId(face);
    if (isAdd === null || faceId === null) {
        return null;
    }
    return {
        group_id: groupId,
        message_seq: msgSeq,
        face_id: faceId,
        reaction_type: "face",
        is_add: isAdd,
    };
}

/** faceId 字段（数字字符串 → number；缺失/非数字 → null）。 */
function reactionFaceId(face: readonly SysMsgField[]): number | null {
    const faceIdText = textOf(face, 1);
    return faceIdText !== null && NUMERIC_RE.test(faceIdText) ? Number(faceIdText) : null;
}

/** is_add 判定：f5=1 添加 / 2 撤销（f3=1 仅添加时存在，双判据）；非法 → null。 */
function reactionIsAdd(face: readonly SysMsgField[]): boolean | null {
    const op = varintOf(face, 5);
    if (op === 1) {
        return true;
    }
    return op === 2 ? false : null;
}

/** 732:1 → group_essence_message_change（is_set=true 快路径；operator 走 diff 回填）。 */
const ESSENCE_RULE: SysMsgKindRuleMilky = {
    kind: "group_essence_message_change",
    extract: (tree) => {
        const hit = extractEssenceSetSysMsg(tree);
        if (hit === null) {
            return null;
        }
        const data: GroupEssenceMessageChangeData = {
            group_id: hit.groupCode,
            message_seq: hit.messageSeq,
            is_set: true,
        };
        return data;
    },
};

/** (msgType, subType) → 规则表（键 = 原生分发键）。 */
const KIND_TABLE: ReadonlyMap<string, SysMsgKindRuleMilky> = new Map([
    ["732:16", REACTION_RULE],
    ["732:1", ESSENCE_RULE],
]);

/** 已观测但未命名的键（多端设备同步族等，不广播只走校准日志）。 */
const OBSERVED_UNNAMED: ReadonlySet<string> = new Set(["528:382", "528:349", "528:381"]);

/** (msgType, subType) → 识别结果（绑定 Milky 表；table 参数供单测注入）。 */
export function recognizeMilkySysMsg(
    msgType: number | null,
    subType: number | null,
    table: ReadonlyMap<string, SysMsgKindRuleMilky> = KIND_TABLE,
): SysMsgRecognition<unknown> {
    return recognizeSysMsgCore(msgType, subType, table, OBSERVED_UNNAMED);
}
