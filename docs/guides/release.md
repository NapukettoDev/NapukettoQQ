# 发布流程

> **铁律：一切发布走发布链，禁止手动 `npm publish`。** 日常发版由
> `.github/workflows/release.yml` 在“携带 changeset 的 PR 合并”后自动完成；npm 侧用
> **Trusted Publisher / OIDC**，仓库不持有长期发布 token。本地 `pnpm release` 只作演练/应急。
>
> PR 纪律：除发布链的版本提交外，一切改动走 PR（分支 → PR → CI → merge queue），禁止人工
> 直推 `main`。changeset 约定见 [development.md](development.md)。

## 1. 两个 job

| job | 职责 | 权限 |
|---|---|---|
| `prepare` | 消费 changeset（`pnpm release:version`）→ 构建 → 测试 → 用 GitHub App token 推送版本提交 → 打包 artifact | `contents: read`；**无** `id-token` |
| `publish` | 解包 artifact → `node tooling/release/release-npm.ts` 逐包发布 | `id-token: write` + `environment: release` 审批；**无** contents 写权限 |

设计约束：

- **构建期代码与 OIDC token 分处两个 job**：package.json 脚本、tsdown 配置都是构建期执行的
  代码，不能和发布 token 同处。`publish` 不跑 `pnpm install`，只用 `node:` 内建模块与 npm CLI。
- **先构建测试、后推送**：失败则 main 上不会留下“版本已升、包却没发”的提交。
- **推送用 GitHub App installation token**：默认 `GITHUB_TOKEN` 推 `main` 会被 ruleset 以
  `GH013` 拒绝，且无法加入 bypass 名单。App 的模式须为 `Always` 或 `exempt`。
- **版本先落 main、发布待审批**：`prepare` 不挂 environment；包要等 `release` 环境批准才上线。
  中间态下 main 版本暂时领先 npm 属正常，发布链的 registry 比对会处理。
- **artifact 保留 30 天**：必须长于审批等待；过期后 publish 取不到产物，只能 `skip-version`
  重跑。

## 2. 触发与幂等

```yaml
on:
    push:
        branches: [main]
        paths: [".changeset/**"]
    workflow_dispatch:
        inputs:
            skip-version: boolean   # true = 跳过 version 环，构建并发布当前 main
```

- `concurrency: group: release` 且不取消进行中的运行，避免两个运行同时消费 changeset。
- 版本提交会删除 `.changeset/` 条目，因此会再触发一次本工作流：那次 `changed=false` 空转
  退出，不会循环；`ci.yml` 也会因 main push 多跑一轮，这是 App token 推送的固有代价。
- `skip-version` 只影响“是否消费 changeset”，不改变审批。

## 3. 一次性仓库配置（非代码）

### 3.1 GitHub App（版本提交直推 main）

1. 组织设置 → Developer settings → GitHub Apps → New GitHub App：
   Repository permissions 只给 **Contents: Read and write**；Webhook 关闭；仅安装到
   `NapukettoDev/NapukettoQQ`。
2. Client ID 存为仓库 variable `RELEASE_APP_CLIENT_ID`；私钥存为 secret
   `RELEASE_APP_PRIVATE_KEY`。
3. 把 App 加进主分支 ruleset 的 **bypass 名单**，模式 `exempt`。

> bypass 的语义是“免于该 ruleset 的全部规则”，不是“只免签名”。App 被滥用即可往 main 推
> 任意内容（绕过 PR、merge queue、签名）。它只出现在 `prepare`，推送时用
> `git -c core.hooksPath=/dev/null` 禁用 hook；剩余面靠 CODEOWNERS 兜底。

### 3.2 Environment

Settings → Environments 建 `release`：

- 勾 **Required reviewers**（本人即可，可自审）。
- **Deployment branches 限制为 main**：`workflow_dispatch` 在被 dispatch 的 ref 上取 workflow
  文件；不限制的话，有写权限者可在分支改文件后 dispatch，借 environment 拿 OIDC。

名字必须与 npm 信任配置里的 environment claim 严格同名。

### 3.3 npm 信任配置（逐包）

每个待发包在 npmjs 侧声明：repository = `NapukettoDev/NapukettoQQ`、workflow =
`release.yml`、environment = `release`、权限只含 publish（不要 stage publish）。

本机执行（npm CLI ≥ 11.15，先 `npm login`）：

```bash
npm trust github @napuketto/kernel --file release.yml --repo NapukettoDev/NapukettoQQ --environment release --allow-publish --yes
npm trust github @napuketto/adapter --file release.yml --repo NapukettoDev/NapukettoQQ --environment release --allow-publish --yes
npm trust github @napuketto/network --file release.yml --repo NapukettoDev/NapukettoQQ --environment release --allow-publish --yes
npm trust github @napuketto/media   --file release.yml --repo NapukettoDev/NapukettoQQ --environment release --allow-publish --yes
npm trust github @napuketto/loader  --file release.yml --repo NapukettoDev/NapukettoQQ --environment release --allow-publish --yes
npm trust github @napuketto/cli     --file release.yml --repo NapukettoDev/NapukettoQQ --environment release --allow-publish --yes
npm trust github create-napukettoqq --file release.yml --repo NapukettoDev/NapukettoQQ --environment release --allow-publish --yes
```

两条最容易踩的规则：

1. **两天过期**：新建信任配置必须在 2 天内完成首次成功发布，逾期失效且不可编辑，只能
   `npm trust revoke <包名> --id <id>` 后重建。按批配置，配完当天就发。
2. **逐包生效**：缺一个只卡一个包。发布前 `release-trust.ts` 会预检，缺配置一次列全且整批不发。

核对：`npm trust list <包名>` 应看到 file / repo / env / 仅 publish 权限。

### 3.4 分支规则集

ruleset「保护主分支」应包含：pull_request（1 审批 + require_code_owner_review）、merge_queue、
required_linear_history、required_signatures、code_scanning，以及必需状态检查：

- `gate (build / check / test / coverage)`
- `windows (test)`
- `audit (fallow 增量门禁)`

`ci.yml` 的 job name 就是检查 context；改名必须同步改规则集。`merge_group` 触发不可省：
merge queue 只认在队列临时 ref 上跑出来的检查。

## 4. 日常发布

1. 功能 PR 随改动带 `.changeset/<名字>.md`，合并进 main。
2. Release 工作流自动触发：`prepare` 消费 changeset、构建、测试、推送版本提交。
3. `publish` 停在 `environment: release` 审批。**审批前看清本次运行的 commit 与 workflow
   内容**——`prepare` 持 App token，若构建期代码被污染，可能已向 main 推过东西。
4. 批准后逐包发布。registry 中已存在的版本自动跳过，因此重跑幂等。
5. 验证：

```bash
npm view @napuketto/kernel version dist.attestations --json
npm view create-napukettoqq version --json
```

`dist.attestations` 存在即该版本经 OIDC 发布并带 provenance（来源 commit 与 workflow 可在
npmjs.com 包页面核验）。

## 5. 补发与排障

- **publish 失败**：重跑 `workflow_dispatch`（changeset 已消费时置 `skip-version=true`），
  registry 比对只发剩余版本。不要手动 `npm publish`。
- **ENEEDAUTH `need auth`**：OIDC 模式下不代表没登录。npm 用 id_token 换包级 token，失败时
  只在 verbose 日志里写原因。看
  `POST 404 .../oidc/token/exchange/package/<包名>`：
  - 404 = 该包没有匹配的信任配置（没配 / claim 不符 / 已过期）→ 按 §3.3 补配，当天重跑。
  - 其他 = 探测/网络问题，看 npm 原始错误。
- **E409 `Cannot publish over previously staged version`**：版本在 npm 暂存区等待批准，
  registry 的 versions 列表里看不到，重跑必然再 409。到 npmjs.com 的 Staged Packages 批准/
  拒绝，或 `npm stage list/approve/reject`（npm ≥ 11.15）。
- **E422 `Failed to validate repository information`**：provenance 校验 package.json 的
  `repository.url` 与 OIDC 来源仓库一致。新包必须带 `repository`（type / url / directory）；
  GitHub 仓改名或转移 owner 后同步更新。
- **202 异步处理**：`npm publish` 成功可能只是 registry 的 202 processing，版本要几分钟才
  可见。刚发完 `npm view` 404 属正常，不要立刻重发（重发会被 registry 比对跳过）。复核用
  `https://registry.npmjs.org/<包名>/<版本>`（版本端点比 packument 缓存新）。
- **artifact 过期**：审批拖过 30 天导致 publish 取不到产物时，用 `skip-version=true` 重跑
  （版本已在 main，只需重新构建与发布）。
- **没有待发布包**：先检查 `.changeset/` 是否有 pending 条目；没有则 `changed=false`，
  不会升版本。

## 6. 本地应急发布

`pnpm release`（= `release:version` + `release:build` + `release:publish`）仍保留，走本机
npm 登录态 + 2FA（`--otp=` / `NAPKETTO_NPM_OTP`）。仅用于演练与排查；正常发布不要用它——
它绕过 environment 审批与 OIDC 信任链。打包检查用 `pnpm release:dryrun`。

## 7. 安全边界

- 发布权 = “谁能让 `release.yml` 在 main 上跑起来”。改 `.github/workflows/**`、
  `tooling/release/**`、`.changeset/**` 等于改发布权，CODEOWNERS 已覆盖。
- `publish` 的 `id-token: write` 不可下放到 `prepare`；`environment: release` 不可删
  （npm 的 claim 会校验，且它是“合并 ≠ 上线”的唯一保证）。
- GitHub App 的 bypass 是整套规则集的豁免，不是单条规则；私钥只应存在于 Actions secret。
