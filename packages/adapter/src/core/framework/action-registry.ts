/**
 * 动作注册表：按动作名索引（构建后只读）。
 * 协议中立泛型——各协议以自己的动作形状实例化（OB11 / Milky / Satori）。
 */
export class ActionRegistry<TAction extends { name: string } = { name: string }> {
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
