import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseToml } from "@napuketto/kernel";
import { expect } from "vitest";
import { cliTest } from "./support.js";

const FILE_CONFIG = 'autoRestart = false\n[[accounts]]\nqq = "20002"\nenabled = false\n';
const INLINE_CONFIG = JSON.stringify({ accounts: [{ qq: "10001", enabled: false }] });
const TOML_ONLY = { NAPUKETTO_LOG_LEVEL: "warn" };

cliTest("默认启动优先读取合法内联配置，保留既有 TOML 且不生成缺失的 TOML", async ({ cli }) => {
    const invalidFile = '[[accounts]]\nqq = "invalid-file-account"\n';
    await writeFile(cli.configPath, invalidFile);

    const inline = { NAPUKETTO_CONFIG_JSON: INLINE_CONFIG };
    const withFile = await cli.run([], inline);
    expect(withFile.code, withFile.stdout + withFile.stderr).toBe(0);
    expect(withFile.stdout).toContain("配置来源: inline（NAPUKETTO_CONFIG_JSON）");
    expect(withFile.stdout).toContain("没有启用的账号");
    expect(await readFile(cli.configPath, "utf8")).toBe(invalidFile);

    await unlink(cli.configPath);
    const withoutFile = await cli.run([], inline);
    expect(withoutFile.code, withoutFile.stdout + withoutFile.stderr).toBe(0);
    expect(withoutFile.stdout).toContain("配置来源: inline（NAPUKETTO_CONFIG_JSON）");
    expect(await readdir(cli.root)).toEqual([]);
});

cliTest("config validate 报告实际生效的来源", async ({ cli }) => {
    await writeFile(cli.configPath, FILE_CONFIG);

    const file = await cli.run(["config", "validate"]);
    expect(file.code, file.stdout + file.stderr).toBe(0);
    expect(file.stdout.trim()).toBe(`配置校验通过（来源: file ${cli.configPath}）`);

    const inline = await cli.run(["config", "validate"], {
        NAPUKETTO_CONFIG_JSON: INLINE_CONFIG,
    });
    expect(inline.code, inline.stdout + inline.stderr).toBe(0);
    expect(inline.stdout.trim()).toBe("配置校验通过（来源: inline）");
    expect(await readFile(cli.configPath, "utf8")).toBe(FILE_CONFIG);
    expect(await readdir(cli.root)).toEqual(["napuketto.toml"]);
});

cliTest("非法内联 JSON 或主配置退出 78，即使文件配置合法", async ({ cli }) => {
    await writeFile(cli.configPath, FILE_CONFIG);

    const startup = await cli.run([], { NAPUKETTO_CONFIG_JSON: "{" });
    expect(startup.code, startup.stdout + startup.stderr).toBe(78);
    expect(startup.stdout).toContain("内联配置 JSON 解析失败");

    const validate = await cli.run(["config", "validate"], {
        NAPUKETTO_CONFIG_JSON: JSON.stringify({ accounts: [] }),
    });
    expect(validate.code, validate.stdout + validate.stderr).toBe(78);
    expect(validate.stdout).toContain("主配置 accounts 必须是非空数组");
    expect(await readFile(cli.configPath, "utf8")).toBe(FILE_CONFIG);
    expect(await readdir(cli.root)).toEqual(["napuketto.toml"]);
});

function expectedConfig(token: string) {
    return {
        autoRestart: false,
        accounts: [{ qq: "20002", enabled: false, onebot11: { token } }],
    };
}

cliTest("config list 默认屏蔽凭据，--show-secrets 显示原值，文件保持原样", async ({ cli }) => {
    const token = "fixture-list-token";
    const original = `${FILE_CONFIG}[accounts.onebot11]\ntoken = "${token}"\n`;
    await writeFile(cli.configPath, original);

    const masked = await cli.run(["config", "list"], TOML_ONLY);
    expect(masked.code, masked.stdout + masked.stderr).toBe(0);
    expect(masked.stdout).not.toContain(token);
    expect(parseToml(masked.stdout)).toMatchObject(expectedConfig("***"));

    const revealed = await cli.run(["config", "list", "--show-secrets"], TOML_ONLY);
    expect(revealed.code, revealed.stdout + revealed.stderr).toBe(0);
    expect(parseToml(revealed.stdout)).toMatchObject(expectedConfig(token));

    const stored = await readFile(cli.configPath, "utf8");
    expect(parseToml(stored)).toEqual(expectedConfig(token));
    expect(stored).toBe(original);
});

cliTest("config apply 的显示选项只影响 stdout，两次写盘均保存新凭据", async ({ cli }) => {
    await writeFile(cli.configPath, FILE_CONFIG);
    const patch = join(cli.root, "patch.json");

    const token = "fixture-apply-token";
    await writeFile(patch, JSON.stringify({ accounts: expectedConfig(token).accounts }));
    const masked = await cli.run(["config", "apply", patch], TOML_ONLY);
    expect(masked.code, masked.stdout + masked.stderr).toBe(0);
    expect(masked.stdout).not.toContain(token);
    expect(parseToml(masked.stdout)).toMatchObject(expectedConfig("***"));
    expect(parseToml(await readFile(cli.configPath, "utf8"))).toMatchObject(expectedConfig(token));

    const replacement = "fixture-replacement-token";
    await writeFile(patch, JSON.stringify({ accounts: expectedConfig(replacement).accounts }));
    const revealed = await cli.run(["config", "apply", patch, "--show-secrets"], TOML_ONLY);
    expect(revealed.code, revealed.stdout + revealed.stderr).toBe(0);
    expect(parseToml(revealed.stdout)).toMatchObject(expectedConfig(replacement));
    expect(parseToml(await readFile(cli.configPath, "utf8"))).toMatchObject(
        expectedConfig(replacement),
    );
});
