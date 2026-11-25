/**
 * boot-log.test.ts：引导文件日志与致命错误输出单测（`shared/boot-log.ts`）。
 */
import { describe, expect, it, vi } from "vitest";
import { bootLogPath, logFatal } from "../boot-log.js";

describe("logFatal（issue #144：致命错误必须上 stderr）", () => {
    it("写 stderr 且带 boot 日志路径；不写 stdout（IPC JSON 协议行零污染）", () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
            logFatal("bootstrap: 协议装配失败: connect ECONNREFUSED 127.0.0.1:5140");
            const text = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
            expect(text).toContain("connect ECONNREFUSED 127.0.0.1:5140");
            // 用户必须能直接定位 boot 日志（Docker 只显示 stderr）
            expect(text).toContain(bootLogPath());
            expect(stdoutSpy).not.toHaveBeenCalled();
        } finally {
            stderrSpy.mockRestore();
            stdoutSpy.mockRestore();
        }
    });
});
