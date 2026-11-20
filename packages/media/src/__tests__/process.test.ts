import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localMediaPath, mediaProcessOptions, readBoundedMediaFile } from "../process.js";
import { MediaError } from "../types.js";

describe("H-02: 进程与本地输入边界", () => {
    let dir: string;
    beforeEach(() => {
        dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nk-process-")));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("超时实际终止不退出的子进程并等待退出", async () => {
        const child = execa(
            process.execPath,
            ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
            mediaProcessOptions(300),
        );
        const result = await child;
        expect(result.timedOut).toBe(true);
        expect(result.failed).toBe(true);
        expect(result.signal).toBeDefined();
        const pid = child.pid;
        if (pid === undefined) throw new Error("child was not spawned");
        expect(() => process.kill(pid, 0)).toThrow();
        if (process.platform !== "win32") expect(result.isForcefullyTerminated).toBe(true);
    });

    it("stdout 超过缓冲上限时实际终止进程", async () => {
        const result = await execa(
            process.execPath,
            ["-e", "process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000)"],
            mediaProcessOptions(3000),
        );
        expect(result.isMaxBuffer).toBe(true);
        expect(result.failed).toBe(true);
    });

    it("目录不能作为媒体文件", async () => {
        await expect(localMediaPath(dir)).rejects.toThrow(MediaError);
    });

    it("普通本地文件与有空格/中文/连字符的路径兼容，读取上限独立于下载器", async () => {
        const input = join(dir, "-中文 input.wav");
        writeFileSync(input, "1234");
        await expect(localMediaPath(input)).resolves.toBe(input);
        await expect(readBoundedMediaFile(input, 4)).resolves.toEqual(Buffer.from("1234"));
        await expect(readBoundedMediaFile(input, 3)).rejects.toThrow(MediaError);
    });
});
