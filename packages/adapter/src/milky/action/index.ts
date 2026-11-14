/**
 * Milky 动作注册表：动作按领域文件组织（每文件一个 create*Actions 工厂），
 * 本入口按固定顺序遍历注册——新增动作在领域文件的工厂里登记即可。
 *
 * 64 动作 = docs/protocols/milky.md §9 清单全量。
 */
import { ActionRegistry } from "../../core/index.js";
import type { MilkyApi } from "../api.js";
import type { MilkyAction } from "./base-action.js";
import { createGroupEssenceActions } from "./group-essence.js";
import { createGroupFileActions } from "./group-file.js";
import { createGroupManageActions } from "./group-manage.js";
import { createGroupNoticeActions } from "./group-notice.js";
import { createGroupQueryActions } from "./group-query.js";
import { createMessageOpsActions } from "./message-ops.js";
import { createMessageQueryActions } from "./message-query.js";
import { createMessageSendActions } from "./message-send.js";
import { createProfileActions } from "./profile.js";
import { createSocialActions } from "./social.js";
import { createSystemActions } from "./system.js";

/** Milky 动作域工厂（注册顺序即列表顺序：system → message → social/profile → group）。 */
const ACTION_FACTORIES: Array<(api: MilkyApi) => MilkyAction[]> = [
    createSystemActions,
    createMessageSendActions,
    createMessageQueryActions,
    createMessageOpsActions,
    createSocialActions,
    createProfileActions,
    createGroupQueryActions,
    createGroupManageActions,
    createGroupEssenceActions,
    createGroupNoticeActions,
    createGroupFileActions,
];

/** 构建 Milky 动作注册表（64 个动作，领域工厂遍历注册）。 */
export function createMilkyActionRegistry(opts: {
    api: MilkyApi;
}): ActionRegistry<MilkyAction<unknown, unknown>> {
    const registry = new ActionRegistry<MilkyAction<unknown, unknown>>();
    for (const factory of ACTION_FACTORIES) {
        for (const action of factory(opts.api)) {
            registry.register(action);
        }
    }
    return registry;
}
