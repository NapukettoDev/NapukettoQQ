/**
 * Satori 动作注册表：动作依赖收敛为 { api: SatoriApi } 单聚合对象。
 *
 * 501 动作：规范「平台支持但适配器未实现 → 501」——QQ 平台不支持的
 * 能力（消息编辑/频道管理/角色管理等）统一注册同名占位动作。
 */

import { z } from "zod";
import { ActionRegistry } from "../../core/framework/action-registry.js";
import type { SatoriApi } from "../api/satori-api.js";
import { defineSatoriAction, type SatoriAction, SatoriActionError } from "./base-action.js";
import { createChannelActions } from "./channel.js";
import { createFriendActions } from "./friend.js";
import { createGuildActions } from "./guild.js";
import { createLoginActions } from "./login.js";
import { createMessageActions } from "./message.js";
import { createReactionActions } from "./reaction.js";
import { createUserActions } from "./user.js";

/** 动作注册依赖（单聚合对象）。 */
export interface SatoriActionDeps {
    api: SatoriApi;
}

/** QQ 平台不支持的 Satori 标准动作（501）。 */
const NOT_IMPLEMENTED = [
    "message.update", // QQ 不支持编辑消息
    "channel.create", // QQ 不支持创建频道
    "channel.update",
    "channel.delete",
    "channel.mute",
    "guild.member.role.set",
    "guild.member.role.unset",
    "guild.role.list",
    "guild.role.create",
    "guild.role.update",
    "guild.role.delete",
    "reaction.clear",
    "reaction.list",
] as const;

/** Satori 动作注册表（core 泛型注册表按 SatoriAction 实例化）。 */
export type SatoriActionRegistry = ActionRegistry<SatoriAction<unknown, unknown>>;

/** 创建 Satori 动作注册表。 */
export function createSatoriActionRegistry(deps: SatoriActionDeps): SatoriActionRegistry {
    const registry = new ActionRegistry<SatoriAction<unknown, unknown>>();
    const { api } = deps;
    for (const action of [
        ...createMessageActions(api),
        ...createChannelActions(api),
        ...createUserActions(api),
        ...createGuildActions(api),
        ...createFriendActions(api),
        ...createLoginActions(api),
        ...createReactionActions(api),
    ]) {
        registry.register(action);
    }
    // 501 占位动作：schema 接受任意对象，执行即抛 501
    for (const name of NOT_IMPLEMENTED) {
        registry.register(
            defineSatoriAction({
                name,
                schema: notImplementedSchema,
                handle: async () => {
                    throw new SatoriActionError(501, `平台不支持该操作: ${name}`);
                },
            }),
        );
    }
    return registry;
}

/** 501 占位动作共用 schema（接受任意对象）。 */
const notImplementedSchema = z.object({}).passthrough();
