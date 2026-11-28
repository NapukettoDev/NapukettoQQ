import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ob11ConfigSchema } from "@napuketto/adapter";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../../dist/index.mjs", import.meta.url));

function validate(messageBudget: { maxItems?: number | string; maxBytes?: number }) {
    const onebot11 = { media: { messageBudget } };
    const configuration = { dataDir: ".napuketto", accounts: [{ qq: "10000", onebot11 }] };
    return spawnSync(
        process.execPath,
        [entry, "config", "validate", "--config-json", JSON.stringify(configuration)],
        {
            encoding: "utf8",
            windowsHide: true,
        },
    );
}

it.each([
    { maxItems: 0 },
    { maxItems: 257 },
    { maxItems: "16" },
    { maxBytes: 1.5 },
    { maxBytes: 536870913 },
])("无效 OB11 预算被协议 schema 拒绝，CLI 返回 78 %j", (messageBudget) => {
    expect(ob11ConfigSchema.safeParse({ media: { messageBudget } }).success).toBe(false);
    const result = validate(messageBudget);
    expect(result.status, result.stderr).toBe(78);
    expect(result.stdout + result.stderr).toContain("messageBudget");
});

it("CLI 允许独立配置其中一个预算字段", () => {
    const result = validate({ maxBytes: 1 });
    expect(result.status, result.stderr).toBe(0);
});
