# create-napukettoqq

一键生成 NapukettoQQ 机器人项目（pnpm / yarn / npm 均可）。

```bash
pnpm create napukettoqq            # 交互输入部署目录名（回车取默认 NapukettoQQ）
pnpm create napukettoqq my-bot     # 位置参数指定目录，跳过交互
```

生成 `package.json` / `napuketto.toml` / `readme.md` / `.gitignore` 骨架，用调用方包管理器自动安装依赖，并询问是否立即启动（默认 Y）。

生成的用户项目依赖发布版的 `@napuketto/cli`，`pnpm start` 即启动。
