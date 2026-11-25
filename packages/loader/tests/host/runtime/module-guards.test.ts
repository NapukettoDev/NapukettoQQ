/**
 * module-guards.test.ts：动态模块导出面守卫独立单测（2026-11-25 P2 补齐盲区）。
 *
 * 这些守卫是 `module-loader.ts` 的收窄面：动态 `import(file://…)` 回来的是
 * `unknown`，守卫误判 = 缺导出在运行期才炸。四协议结构同构（适配器构造器 +
 * `<key>ConfigSchema.parse`，kurobot 另有 defaults），因此同时断言「同构收敛」
 * 与「各自差异」两条线。
 *
 * 注：模块导出面键名（`NapukettoOneBot11Adapter` 等）是 kernel/adapter 的原始
 * PascalCase 契约，用 `moduleSurface` 的键值对构造，避免对象字面量命名规则冲突。
 */
import { describe, expect, it } from "vitest";
import {
    isAdapterCoreModule,
    isKernelModule,
    isKurobotModule,
    isMilkyModule,
    isNetworkModule,
    isOb11Module,
    isSatoriModule,
} from "../../../src/host/runtime/module-guards.js";

/** 按模块导出面的原始键名构造对象（键名是跨包契约，不能改大小写）。 */
function moduleSurface(entries: [string, unknown][]): Record<string, unknown> {
    return Object.fromEntries(entries);
}

/** 协议配置 schema 替身（`parse` 可调用即可）。 */
const schema = { parse: (input: unknown) => input };

/** 适配器构造器替身。 */
class AdapterCtor {}

describe("isKernelModule（startNapuketto / NapukettoCore 任一入口）", () => {
    it("startNapuketto 可调用 → true", () => {
        expect(isKernelModule({ startNapuketto: () => undefined })).toBe(true);
    });

    it("NapukettoCore 构造器 → true", () => {
        expect(isKernelModule(moduleSurface([["NapukettoCore", class {}]]))).toBe(true);
    });

    it("两条入口都缺 / 非函数 / 非对象 → false", () => {
        expect(isKernelModule({})).toBe(false);
        expect(isKernelModule({ startNapuketto: 1 })).toBe(false);
        expect(isKernelModule(moduleSurface([["NapukettoCore", 2]]))).toBe(false);
        expect(isKernelModule([])).toBe(false);
        expect(isKernelModule(null)).toBe(false);
    });
});

describe("isNetworkModule（EventBroadcaster 构造器）", () => {
    it("构造器存在 → true；缺失或非函数 → false", () => {
        expect(isNetworkModule(moduleSurface([["EventBroadcaster", class {}]]))).toBe(true);
        expect(isNetworkModule(moduleSurface([["EventBroadcaster", {}]]))).toBe(false);
        expect(isNetworkModule({})).toBe(false);
    });
});

describe("isOb11Module / isSatoriModule / isMilkyModule（同构协议面）", () => {
    it("构造器 + schema.parse 齐备 → 三个协议守卫均命中", () => {
        expect(
            isOb11Module(
                moduleSurface([
                    ["NapukettoOneBot11Adapter", AdapterCtor],
                    ["ob11ConfigSchema", schema],
                ]),
            ),
        ).toBe(true);
        expect(
            isSatoriModule(
                moduleSurface([
                    ["NapukettoSatoriAdapter", AdapterCtor],
                    ["satoriConfigSchema", schema],
                ]),
            ),
        ).toBe(true);
        expect(
            isMilkyModule(
                moduleSurface([
                    ["NapukettoMilkyAdapter", AdapterCtor],
                    ["milkyConfigSchema", schema],
                ]),
            ),
        ).toBe(true);
    });

    it("构造器缺失 / schema 非对象 / schema.parse 非函数 → false", () => {
        expect(isOb11Module(moduleSurface([["ob11ConfigSchema", schema]]))).toBe(false);
        expect(
            isOb11Module(
                moduleSurface([
                    ["NapukettoOneBot11Adapter", AdapterCtor],
                    ["ob11ConfigSchema", "x"],
                ]),
            ),
        ).toBe(false);
        expect(
            isOb11Module(
                moduleSurface([
                    ["NapukettoOneBot11Adapter", AdapterCtor],
                    ["ob11ConfigSchema", { parse: 1 }],
                ]),
            ),
        ).toBe(false);
        expect(isSatoriModule({})).toBe(false);
        expect(isMilkyModule(null)).toBe(false);
    });

    it("守卫命中后可安全调用 schema.parse（收窄有效）", () => {
        const mod: unknown = moduleSurface([
            ["NapukettoOneBot11Adapter", AdapterCtor],
            ["ob11ConfigSchema", { parse: () => ({ ok: true }) }],
        ]);
        if (!isOb11Module(mod)) {
            throw new Error("守卫应命中");
        }
        expect(mod.ob11ConfigSchema.parse({})).toEqual({ ok: true });
    });
});

describe("isKurobotModule（同构面 + defaults 强制）", () => {
    it("构造器 + schema.parse + defaults 齐备 → true", () => {
        expect(
            isKurobotModule(
                moduleSurface([
                    ["NapukettoKurobotAdapter", AdapterCtor],
                    ["kurobotConfigSchema", schema],
                    ["kurobotConfigDefaults", () => ({})],
                ]),
            ),
        ).toBe(true);
    });

    it("缺 defaults / defaults 非函数 → false（其余协议无此要求）", () => {
        expect(
            isKurobotModule(
                moduleSurface([
                    ["NapukettoKurobotAdapter", AdapterCtor],
                    ["kurobotConfigSchema", schema],
                ]),
            ),
        ).toBe(false);
        expect(
            isKurobotModule(
                moduleSurface([
                    ["NapukettoKurobotAdapter", AdapterCtor],
                    ["kurobotConfigSchema", schema],
                    ["kurobotConfigDefaults", {}],
                ]),
            ),
        ).toBe(false);
    });
});

describe("isAdapterCoreModule（ProtocolConfig 方法面）", () => {
    it("ProtocolConfig 可调用 → true；缺失 / 非函数 / 非对象 → false", () => {
        expect(isAdapterCoreModule(moduleSurface([["ProtocolConfig", class {}]]))).toBe(true);
        expect(isAdapterCoreModule(moduleSurface([["ProtocolConfig", () => undefined]]))).toBe(
            true,
        );
        expect(isAdapterCoreModule({})).toBe(false);
        expect(isAdapterCoreModule(moduleSurface([["ProtocolConfig", {}]]))).toBe(false);
        expect(isAdapterCoreModule(null)).toBe(false);
    });
});
