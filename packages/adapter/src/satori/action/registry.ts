/**
 * Satori 动作注册表（按动作名索引，构建后只读）。
 * 复用 core 泛型 ActionRegistry（2026-08-08 克隆合并）。
 */
import type { ActionRegistry } from "../../core/framework/action-registry.js";
import type { BaseSatoriAction } from "./base-action.js";

/** Satori 动作注册表（BaseSatoriAction 专用）。 */
export type SatoriActionRegistry = ActionRegistry<BaseSatoriAction<unknown, unknown>>;
