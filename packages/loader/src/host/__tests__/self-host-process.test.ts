import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("标准 Node 子进程验证断管、清理、控制退出、同代身份和并发锁", async () => {
    const fixture = fileURLToPath(new URL("./self-host-process.integration.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--test", "--test-reporter=tap", fixture],
        {
            timeout: 30_000,
        },
    );
    expect(stdout).toContain("# fail 0");
}, 35_000);
