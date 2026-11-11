/**
 * update-qq-releases.import.test.ts：兜底命令「node 直接跑」的可加载性守卫。
 *
 * 为什么单独一个文件：脚本靠 `node` 直接执行 TypeScript（类型剥离），不做 `.js` →
 * `.ts` 的说明符重写——它依赖链上只要出现一个相对 import，加载就会
 * `ERR_MODULE_NOT_FOUND`（源码分组重构后真实踩过一次：CI 定时任务与 issue 里写的本地
 * 兜底命令双双失效）。vitest 会重写说明符，所以普通单测全绿也发现不了；这里用子进程
 * 真加载一次模块图。`-e` 下 `process.argv[1]` 为空，脚本的「直接执行」判定不会触发，
 * 因此不下载、不写清单、不访问外网。
 */
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/** 被测脚本的 file: URL（与 cwd 无关，子进程在哪个目录都能加载）。 */
const SCRIPT_URL = pathToFileURL(
    fileURLToPath(new URL("./update-qq-releases.ts", import.meta.url)),
).href;

/** 以 node 子进程加载脚本模块图（只 import，不执行 main），返回 stdout。 */
function loadScriptModule(): Promise<string> {
    const code = `await import(${JSON.stringify(SCRIPT_URL)}); console.log("ok");`;
    return new Promise((resolve, reject) => {
        execFile(
            process.execPath,
            ["--input-type=module", "-e", code],
            { timeout: 30_000 },
            (err, stdout, stderr) => {
                if (err !== null) {
                    reject(new Error(`${err.message}\n${stderr.trim()}`));
                    return;
                }
                resolve(stdout);
            },
        );
    });
}

describe("node 直接执行脚本", () => {
    it("import 依赖链可加载（类型剥离，无构建、无 .js→.ts 重写）", async () => {
        const stdout = await loadScriptModule();
        expect(stdout.trim()).toBe("ok");
    });
});
