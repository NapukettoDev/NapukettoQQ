/**
 * pid-cmdline.test.ts：跨进程命令行查询单测（pid-cmdline.ts）。
 *
 * 平台分支经 Object.defineProperty(process, "platform") 切换（属性 configurable）+
 * vi.resetModules 动态 import 取全新模块（CMDLINE_PROBE_SUPPORTED 随平台重算）；
 * execFileSync / readFileSync 经 vi.mock 拦截（不 spawn PowerShell、不读 /proc）。
 * normalizeCmdline / selfCmdline / readCmdlineForPid 为纯运行时函数（静态 import）。
 * 覆盖：
 *  - normalizeCmdline：大小写 / 引号 / 路径分隔符 / 空白折叠
 *  - selfCmdline：execArgv + argv 拼接
 *  - readCmdlineForPid：win32（PowerShell 输出 / 空 / 抛错）、linux（/proc cmdline
 *    \0 转空格 / 空 / 抛错）、其他平台 null（不发起查询）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCmdline, readCmdlineForPid, selfCmdline } from "./pid-cmdline.js";

/** execFileSync / readFileSync mock 记录（vi.hoisted：mock 工厂内可见）。 */
const h = vi.hoisted(() => {
    return {
        execCalls: [] as Array<{ exe: string; args: string[] }>,
        execResult: "" as string,
        execError: null as null | Error,
        procFiles: new Map<string, string>(),
        procError: false,
    };
});

vi.mock("node:child_process", () => ({
    execFileSync: vi.fn((exe: string, args: string[]) => {
        h.execCalls.push({ exe, args });
        if (h.execError !== null) {
            throw h.execError;
        }
        return h.execResult;
    }),
}));

vi.mock("node:fs", () => ({
    readFileSync: vi.fn((path: string) => {
        const content = h.procFiles.get(String(path));
        if (h.procError || content === undefined) {
            throw new Error("ENOENT");
        }
        return content;
    }),
}));

afterEach(() => {
    h.execCalls.length = 0;
    h.execResult = "";
    h.execError = null;
    h.procFiles.clear();
    h.procError = false;
});

/** 平台切换（可配置属性；用后还原）。 */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
        value: platform,
        configurable: true,
        writable: true,
        enumerable: true,
    });
    return fn().finally(() => {
        if (original !== undefined) {
            Object.defineProperty(process, "platform", {
                value: original.value,
                configurable: true,
                writable: true,
                enumerable: true,
            });
        }
    });
}

/** 取全新模块（CMDLINE_PROBE_SUPPORTED 随当前平台重算）。 */
async function fresh(): Promise<typeof import("./pid-cmdline.js")> {
    vi.resetModules();
    return await import("./pid-cmdline.js");
}

describe("normalizeCmdline", () => {
    it("大小写归一（Windows 路径大小写不敏感）+ 反斜杠转正斜杠", () => {
        expect(normalizeCmdline("C:\\Program Files\\Node\\Node.EXE --flag")).toBe(
            "c:/program files/node/node.exe --flag",
        );
    });

    it("去引号 + 折叠空白 + 去首尾空格", () => {
        expect(normalizeCmdline('"C:\\node.exe"   --a   --b  ')).toBe("c:/node.exe --a --b");
    });

    it("空串 → 空串", () => {
        expect(normalizeCmdline("")).toBe("");
    });
});

describe("selfCmdline", () => {
    it("execArgv + argv 空格拼接（与写锁摘要结构一致）", () => {
        expect(selfCmdline()).toBe([...process.execArgv, ...process.argv].join(" ").trim());
    });
});

describe("readCmdlineForPid：win32 分支", () => {
    it("PowerShell Get-CimInstance 查询：命令含 pid 过滤与 UTF-8 输出设置", async () => {
        await withPlatform("win32", async () => {
            h.execResult = "C:\\node.exe self-host.cjs\r\n";
            expect(readCmdlineForPid(4242)).toBe("C:\\node.exe self-host.cjs");
            expect(h.execCalls).toHaveLength(1);
            const call = h.execCalls[0];
            expect(call?.exe).toBe("powershell.exe");
            expect(call?.args.join(" ")).toContain("ProcessId=4242");
            expect(call?.args.join(" ")).toContain("OutputEncoding");
        });
    });

    it("输出为空（进程不存在 / 系统进程 null CommandLine）→ null", async () => {
        await withPlatform("win32", async () => {
            h.execResult = "   ";
            expect(readCmdlineForPid(1)).toBeNull();
        });
    });

    it("查询抛错（超时 / PowerShell 缺失）→ null", async () => {
        await withPlatform("win32", async () => {
            h.execError = new Error("命令超时");
            expect(readCmdlineForPid(1)).toBeNull();
        });
    });

    it("win32 平台 CMDLINE_PROBE_SUPPORTED = true", async () => {
        await withPlatform("win32", async () => {
            const mod = await fresh();
            expect(mod.CMDLINE_PROBE_SUPPORTED).toBe(true);
        });
    });
});

describe("readCmdlineForPid：linux 分支", () => {
    it("/proc/<pid>/cmdline：\\0 分隔转空格", async () => {
        await withPlatform("linux", async () => {
            h.procFiles.set("/proc/777/cmdline", "node\0self-host.cjs\0--flag\0");
            expect(readCmdlineForPid(777)).toBe("node self-host.cjs --flag");
        });
    });

    it("文件不存在 / 内容空 → null", async () => {
        await withPlatform("linux", async () => {
            expect(readCmdlineForPid(888)).toBeNull();
            h.procFiles.set("/proc/889/cmdline", "\0\0");
            expect(readCmdlineForPid(889)).toBeNull();
        });
    });

    it("读取抛错（权限）→ null", async () => {
        await withPlatform("linux", async () => {
            h.procError = true;
            expect(readCmdlineForPid(890)).toBeNull();
        });
    });

    it("linux 平台 CMDLINE_PROBE_SUPPORTED = true", async () => {
        await withPlatform("linux", async () => {
            const mod = await fresh();
            expect(mod.CMDLINE_PROBE_SUPPORTED).toBe(true);
        });
    });
});

describe("readCmdlineForPid：其他平台", () => {
    it("darwin → null（判活退回纯 pid 探测，不发起任何查询）", async () => {
        await withPlatform("darwin", async () => {
            const mod = await fresh();
            expect(mod.readCmdlineForPid(1)).toBeNull();
            expect(h.execCalls).toHaveLength(0);
            expect(mod.CMDLINE_PROBE_SUPPORTED).toBe(false);
        });
    });
});
