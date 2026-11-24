/**
 * wrapper-native-boot.test.ts：自建宿主原生引导原语单测（2026-11 从 loader 下沉）。
 *
 * 覆盖 dlopenWrapper（成功 / 缺核心导出 / dlopen 抛错）与 activateO3MiscService
 * （激活 / 缺失 / get() 抛错）。全程 spy process.dlopen，绝不加载真实 wrapper.node。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelError } from "../../infra/index.js";
import { activateO3MiscService } from "../lifecycle.js";
import { dlopenWrapper } from "../loader.js";

/** kernel 登录服务构造器导出名（避免字面量键触发命名约定规则）。 */
const LOGIN_CTOR = "NodeIKernelLoginService";
/** O3 事件分发服务导出名。 */
const O3_SERVICE = "NodeIO3MiscService";
/** 非登录类服务导出名（缺核心导出的反例用）。 */
const BUDDY_SERVICE = "NodeIKernelBuddyService";

afterEach(() => {
    vi.restoreAllMocks();
});

/** dlopen spy（按行为填充 exports 或抛错）。 */
function mockDlopen(exportsOrError: Record<string, unknown> | Error): void {
    vi.spyOn(process, "dlopen").mockImplementation((module: object, _filename: string) => {
        if (exportsOrError instanceof Error) {
            throw exportsOrError;
        }
        Object.assign(
            (module as unknown as { exports: Record<string, unknown> }).exports,
            exportsOrError,
        );
    });
}

describe("dlopenWrapper", () => {
    it("dlopen 填充 exports 且含 NodeIKernelLoginService → 原样返回 exports", () => {
        const exports: Record<string, unknown> = { [LOGIN_CTOR]: {}, [BUDDY_SERVICE]: {} };
        mockDlopen(exports);
        const out = dlopenWrapper("X:/qq/resources/app/wrapper.node");
        expect(out).toEqual(exports);
        expect(out[LOGIN_CTOR]).toBeDefined();
    });

    it("exports 缺 NodeIKernelLoginService → KernelError INVALID_STATE", () => {
        mockDlopen({ [BUDDY_SERVICE]: {} });
        expect(() => dlopenWrapper("X:/wrapper.node")).toThrow(KernelError);
        expect(() => dlopenWrapper("X:/wrapper.node")).toThrow(/NodeIKernelLoginService/);
    });

    it("dlopen 抛错 → 原样向上抛（由调用方收敛退出码）", () => {
        mockDlopen(new Error("stub 符号缺失"));
        expect(() => dlopenWrapper("X:/wrapper.node")).toThrow(/stub 符号缺失/);
    });
});

describe("activateO3MiscService", () => {
    it("get().addO3MiscListener 被调用一次 → true", () => {
        const listeners: unknown[] = [];
        const exports: Record<string, unknown> = {
            [O3_SERVICE]: {
                get: () => ({
                    addO3MiscListener: (listener: unknown) => {
                        listeners.push(listener);
                    },
                }),
            },
        };
        expect(activateO3MiscService(exports)).toBe(true);
        expect(listeners).toHaveLength(1);
        // wrapper 契约回调存在（空实现即可注册）
        expect(listeners[0]).toHaveProperty("getOnAmgomDataPiece");
    });

    it("exports 为空 / 缺 O3MiscService → false（不阻断引导）", () => {
        expect(activateO3MiscService(undefined)).toBe(false);
        expect(activateO3MiscService({})).toBe(false);
        expect(activateO3MiscService({ [O3_SERVICE]: {} })).toBe(false);
    });

    it("get() 抛错 → 向上抛（调用方 best-effort 捕获）", () => {
        mockDlopen({});
        const exports: Record<string, unknown> = {
            [O3_SERVICE]: {
                get: () => {
                    throw new Error("激活断言");
                },
            },
        };
        expect(() => activateO3MiscService(exports)).toThrow(/激活断言/);
    });
});
