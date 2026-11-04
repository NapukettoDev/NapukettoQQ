/**
 * index.test.ts：进程入口单测。
 *
 * 入口只做一件事：import 即调用 cli/program.ts 的 main()（shebang + 无业务）。
 * program 层换桩，断言 import 副作用恰好调用一次 main。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ main: vi.fn() }));

vi.mock("./cli/program.js", () => ({ main: mocks.main }));

beforeEach(() => {
    mocks.main.mockReset();
});

describe("进程入口（index.ts）", () => {
    it("import 入口模块即调用 main()（恰好一次，无额外副作用）", async () => {
        await import("./index.js");
        expect(mocks.main).toHaveBeenCalledTimes(1);
    });
});
