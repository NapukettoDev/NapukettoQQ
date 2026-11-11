# create-napukettoqq

一键生成 NapukettoQQ 机器人项目（pnpm / yarn / npm 均可）。

```bash
pnpm create napukettoqq            # 交互输入部署目录名（回车取默认 NapukettoQQ）
pnpm create napukettoqq my-bot     # 位置参数指定目录，跳过交互
```

生成 `package.json` / `napuketto.toml`（yarn 额外写空 `yarn.lock` 隔离父目录 workspace），
用调用方包管理器安装依赖，然后打开配置模板填写 `qq` 与 `token`；不会自动启动。

生成的用户项目依赖发布版的 `@napuketto/cli`，填好配置后 `pnpm start` 即可启动。
