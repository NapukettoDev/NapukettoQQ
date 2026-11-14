/**
 * OneBot 11 动作注册表
 * 各协议维护自己的 ActionRegistry，由协议 adapter 挂到请求分发。
 * deps 收敛为 { api: OneBotApi } 单聚合对象。
 *
 * 同时是 action 域 barrel：re-export ob11ErrorCodeMap / resolveUid（base-action）/
 * AtAllRemainInfo，协议外部只从本入口消费动作面。动作按领域分文件（message/ group/
 * friend/ system/），各领域文件导出 create*Actions 工厂，此处遍历注册——新增动作在
 * 领域文件的工厂里登记即可。
 */
import { ActionRegistry } from "../../core/index.js";
import type { OneBotApi } from "../api/one-bot-api.js";
import type { Ob11Action } from "./base-action.js";
import { createFriendManageActions } from "./friend/manage.js";
import { createFriendQueryActions } from "./friend/query.js";
import { createGroupEssenceActions } from "./group/essence.js";
import { createGroupSystemMsgActions } from "./group/get-group-system-msg.js";
import { createGroupFileOpActions } from "./group/group-files-op.js";
import { createGroupFileQueryActions } from "./group/group-files-query.js";
import { createGroupManageActions } from "./group/manage.js";
import { createGroupNotifyActions } from "./group/notify.js";
import { createGroupQueryActions } from "./group/query.js";
import { createForwardActions } from "./message/forward.js";
import { createHistoryActions } from "./message/history.js";
import { createMediaActions } from "./message/media.js";
import { createMsgOpsActions } from "./message/ops.js";
import { createSendActions } from "./message/send.js";
import { createSystemAccountActions } from "./system/account.js";
import { createSystemFileActions } from "./system/file.js";
import { createSystemInfoActions } from "./system/info.js";
import { createSystemStatusActions } from "./system/status.js";

export { ob11ErrorCodeMap, resolveUid } from "./base-action.js";
export type { AtAllRemainInfo } from "./group/query.js";

/** 动作注册表依赖（动作只依赖一个聚合对象）。 */
export interface Ob11ActionDeps {
    /** OneBotApi 聚合（9 个 kernel apis + messageUnique + self/system）。 */
    api: OneBotApi;
}

/** 动作工厂签名（各领域文件提供，按域组装动作）。 */
type Ob11ActionFactory = (api: OneBotApi) => Ob11Action[];

/** 全部领域工厂（18 个：message×5 + group×7 + friend×2 + system×4）。 */
const ACTION_FACTORIES: Ob11ActionFactory[] = [
    createSendActions,
    createHistoryActions,
    createMsgOpsActions,
    createMediaActions,
    createForwardActions,
    createGroupManageActions,
    createGroupQueryActions,
    createGroupEssenceActions,
    createGroupNotifyActions,
    createGroupSystemMsgActions,
    createGroupFileQueryActions,
    createGroupFileOpActions,
    createFriendQueryActions,
    createFriendManageActions,
    createSystemInfoActions,
    createSystemStatusActions,
    createSystemAccountActions,
    createSystemFileActions,
];

/** 构建 OB11 动作注册表（81 个动作，领域工厂遍历注册）。 */
export function createOb11ActionRegistry(deps: Ob11ActionDeps): ActionRegistry<Ob11Action> {
    const registry = new ActionRegistry<Ob11Action>();
    for (const factory of ACTION_FACTORIES) {
        for (const action of factory(deps.api)) {
            registry.register(action);
        }
    }
    return registry;
}
