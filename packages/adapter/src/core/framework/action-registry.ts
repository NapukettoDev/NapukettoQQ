/**
 * 动作注册表：按动作名索引（构建后只读）。
 * 泛型化（2026-08-08 克隆合并）：OB11 与 Satori 共用同一注册表实现。
 */
import type { BaseAction } from "./base-action.js";

export class ActionRegistry<TAction extends { name: string } = BaseAction<unknown, unknown>> {
    private readonly actions = new Map<string, TAction>();

    register(action: TAction): void {
        this.actions.set(action.name, action);
    }

    get(name: string): TAction | undefined {
        return this.actions.get(name);
    }

    has(name: string): boolean {
        return this.actions.has(name);
    }

    get names(): string[] {
        return [...this.actions.keys()];
    }
}
