/**
 * OB11 sysmsg 识别表（自 helper/sysmsg.ts 瘦身——解码层上移
 * shared/sysmsg.ts 共享，milky.md §0.8.3/§0.8.6）
 *
 * 本模块只保留 OB11 侧内容：
 *  - SysMsgNoticeKind：sysmsg 可映射的 OB11 notice 种类（event/notice.ts 既有类型）
 *  - KIND_TABLE：(msgType, subType) → 规则（键 = 原生分发键）
 *  - OBSERVED_UNNAMED：已观测但未命名的键（不广播，防校准日志噪音）
 *  - recognizeSysMsg：绑定 OB11 表的识别入口
 *
 * 解码原语（decodeProtoTree / extractSysMsgEnvelope / narrowSysMsgBlobs 等）
 * 从 `shared/sysmsg.js` 导入使用。
 */

import {
    recognizeSysMsg as recognizeSysMsgCore,
    type SysMsgKindRule,
    type SysMsgRecognition,
} from "../../shared/sysmsg.js";
import type { OB11GroupCardNoticeEvent, OB11NoticeEvent } from "../event/index.js";

/** 群号判别（strings[0] 必须是数字串）。 */
const NUMERIC_RE = /^\d+$/;

export type {
    SysMsgEnvelope,
    SysMsgField,
    SysMsgKindRule,
    SysMsgRecognition,
} from "../../shared/sysmsg.js";
export {
    decodeProtoTree,
    extractSysMsgEnvelope,
    narrowSysMsgBlobs,
    toHex,
} from "../../shared/sysmsg.js";

/** OB11 识别规则：kind 收窄为 OB11 notice 种类、事件体为 OB11NoticeEvent。 */
export type SysMsgKindRuleOB11 = SysMsgKindRule<OB11NoticeEvent>;

/**
 * 732:21 群名片变更（轮录制实证）：collectStrings 顺序 =
 * [群号, 对象 uid, 新值, 旧值]。判别式：strings[0] 全数字 + strings[1] uid
 * 形（u_ 前缀）——不满足即弃（降级校准日志，防其他键的串污染误判）。
 */
const GROUP_CARD_RULE: SysMsgKindRuleOB11 = {
    kind: "group_card",
    collectUids: (_tree, env) => {
        const subject = env.strings[1];
        return subject?.startsWith("u_") === true ? [subject] : [];
    },
    extract: (_tree, env, uinOf, ctx) => {
        const [groupCode, subject, cardNew, cardOld] = env.strings;
        if (
            groupCode === undefined ||
            subject === undefined ||
            !NUMERIC_RE.test(groupCode) ||
            !subject.startsWith("u_")
        ) {
            return null;
        }
        const event: OB11GroupCardNoticeEvent = {
            time: ctx.time,
            self_id: ctx.selfUin,
            post_type: "notice",
            notice_type: "group_card",
            group_id: Number(groupCode),
            user_id: uinOf(subject),
            card_new: cardNew ?? "",
            card_old: cardOld ?? "",
        };
        return event;
    },
};

/**
 * (msgType, subType) → 规则表（键 = 原生分发键，design.md §7.1）。
 *
 * 不再是空表：732:21（群名片变更）为轮录制取得的首个
 * 实证条目。card/title 等其余判别值仍无样本支撑，宁可漏报不错报；未识别
 * 一律走结构化校准日志，不广播。
 */
const KIND_TABLE: ReadonlyMap<string, SysMsgKindRuleOB11> = new Map([["732:21", GROUP_CARD_RULE]]);

/** 已观测但未命名的 (msgType, subType)（语义未知，不广播）。 */
const OBSERVED_UNNAMED: ReadonlySet<string> = new Set(["528:382", "528:349", "528:381"]);

/** (msgType, subType) → 识别结果（绑定 OB11 表；table 参数供单测注入合成规则）。 */
export function recognizeOb11SysMsg(
    msgType: number | null,
    subType: number | null,
    table: ReadonlyMap<string, SysMsgKindRuleOB11> = KIND_TABLE,
): SysMsgRecognition<OB11NoticeEvent> {
    return recognizeSysMsgCore(msgType, subType, table, OBSERVED_UNNAMED);
}
