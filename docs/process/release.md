# 发布流程（RELEASE）

> **铁律：一切发布走发布链，禁止手动 `npm publish`。** 日常发版由
> `.github/workflows/release.yml` 在「携带 changeset 的 PR 合并」后自动完成：
> npm 侧走**可信发布（Trusted Publisher / OIDC）**，不存在任何长期 token，
> 本机也不再需要持有发布能力。本地 `pnpm release` 只保留作演练 / 应急。
>
> **PR 纪律**：除发布链的版本提交（`prepare` job 推 main，见 §1）外，一切改动
> 走 PR（分支 → PR → CI 门禁 → merge queue），禁止人工直推 main。
>
> 先读：CI 门禁见 [../../.github/workflows/ci.yml](../../.github/workflows/ci.yml)，
> changeset 约定见 [../../AGENTS.md](../../AGENTS.md)。

## 1. 两 job 分工

| job | 职责 | 权限 |
|---|---|---|
| `prepare` | 消费 changeset（`pnpm release:version`）→ 构建 → 测试 → 用 GitHub App token 推送版本提交 → 打包 artifact | `contents: read`；**无** `id-token` |
| `publish` | 解包 artifact → `node tooling/release/release-npm.ts`（逐包 npm publish） | `id-token: write` + `environment: release` 审批；**无** contents 写权限 |

设计约束：

- **构建期代码与 OIDC token 必须分处两个 job。** package.json 脚本、tsdown 配置
  都是构建期执行的代码，一处被改坏就能拿着 token 发这 7 个包的任意版本。故
  `publish` 不跑 `pnpm install`：发布链只用 `node:` 内建模块与 npm CLI。
- **推送排在构建与测试之后**：构建或测试失败则 main 上不会留下「版本已升、包却
  没发出去」的提交。
- **推送凭证是 GitHub App 的 installation token**：默认 `GITHUB_TOKEN` 推 main
  会被 ruleset 以 `GH013` 拒绝，且它无法被加入 ruleset 的 bypass 名单（GitHub
  的安全限制）；能进名单的只有 GitHub App，模式须为 `Always` 或 `exempt`。
- **版本先落 main、发布待审批**：`prepare` 不挂 environment，版本提交与 CHANGELOG
  在构建测试通过后立即进 main；包要等 `environment: release` 批准才真正上线。
  中间态下 main 的版本暂时领先 npm 属正常，发布链的 registry 比对能安全处理。
- **artifact retention 必须长于审批等待**：当前 30 天。审批拖过期限会让 publish
  第一步 `download-artifact` 失败（版本已进 main、包一个没发），只能 skip-version
  补发。

## 2. 触发

```yaml
on:
    push:
        branches: [main]
        paths: [".changeset/**"]   # 只有携带 changeset 的合并才值得跑
    workflow_dispatch:             # 补发 / 重跑逃生舱
        inputs:
            skip-version: boolean  # true = 跳过 version 环，直接构建并发布当前 main
```

- `concurrency: group: release` 且不取消进行中的运行，避免两个运行同时消费
  changeset 撞版本号。
- 版本提交会删除 `.changeset/` 条目，因此它会再触发一次本工作流：那次运行
  `changed=false` 空转退出，不会循环；`ci.yml` 也会因 main push 多跑一轮，这是
  App token 推送（而非 GITHUB_TOKEN）的固有代价。
- `skip-version` 只影响「要不要消费 changeset」，不改变任何审批。

## 3. 一次性仓库配置（非代码）

### 3.1 GitHub App（版本提交直推 main）

1. 组织设置 → Developer settings → GitHub Apps → New GitHub App：
   - Repository permissions 只给 **Contents: Read and write**；Webhook 关闭。
   - 仅安装到 `NapukettoDev/NapukettoQQ`。
2. 把 **Client ID** 存成仓库 variable `RELEASE_APP_CLIENT_ID`（Client ID 非敏感，
   本来就出现在安装 URL 里），私钥存成 secret `RELEASE_APP_PRIVATE_KEY`。
3. 把该 App 加进主分支 ruleset 的 **bypass 名单**，模式 `exempt`。

> **代价写清**：bypass 的语义是「免于该 ruleset 的全部规则」，不是「只免签名」。
> 这个 App 被滥用即可往 main 推任意内容（绕过 PR、merge queue、签名）。它出现在
> `prepare` job 里（构建期代码执行之后），只在这一步取用，推送时用
> `git -c core.hooksPath=/dev/null` 禁用 hook；剩余面靠 CODEOWNERS 兜底。

### 3.2 Environment

Settings → Environments 建 `release`：

- 勾 **Required reviewers**（本人即可，可自审）。
- **Deployment branches 限制为 main**：`workflow_dispatch` 是在被 dispatch 的
  ref 上取 workflow 文件的，不限制的话，有写权限者可在分支上改本文件后 dispatch，
  借 environment 拿到 OIDC。

名字必须与 npm 信任配置的 environment claim 严格同名。

### 3.3 npm 信任配置（逐包，非仓库级开关）

每个待发包在 npmjs 侧声明：

- repository = `NapukettoDev/NapukettoQQ`
- workflow 文件 = `release.yml`
- environment = `release`
- 权限只含 publish（不要 stage publish，避免引入人工批准环节的暂存流程）

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

1. **两天过期**：新建的信任配置必须在 2 天内完成首次成功发布，才算验证通过；
   逾期即失效，且失效记录**不可编辑**，只能 `npm trust revoke <包名> --id <id>`
   后重建。所以不要提前把全部包配齐——按批配置、配完当天就发。
2. **逐包生效**：缺一个只卡一个包。发布链会在发包前做预检（`release-trust.ts`），
   缺配置一次列全且整批不发。

核对：`npm trust list <包名>` 应看到 file / repo / env / 仅 publish 权限。

### 3.4 分支规则集

ruleset「保护主分支」应包含：pull_request（1 审批 + require_code_owner_review）、
merge_queue、required_linear_history、required_signatures、code_scanning，以及
**必需状态检查**：

- `gate (build / check / test / coverage)`
- `windows (test)`
- `audit (fallow 增量门禁)`

`ci.yml` 的 job name 就是检查 context；改名必须同步改规则集，否则 PR 永远等不到
同名检查。`merge_group` 触发不可省：merge queue 只认在队列临时 ref 上跑出来的
检查。

## 4. 日常发布

1. 功能 PR 随改动带 `.changeset/<名字>.md`，合并进 main。
2. Release 工作流自动触发：`prepare` 消费 changeset、构建、测试、推送版本提交。
3. `publish` 停在 `environment: release` 审批。**审批前看清本次运行的 commit 与
   workflow 内容**——`prepare` 持 App token，若其构建期代码被污染，可能已向 main
   推过东西。
4. 批准后逐包发布。已在 registry 的版本自动跳过，因此重跑幂等。
5. 验证：

```bash
npm view @napuketto/kernel version dist.attestations --json
npm view create-napukettoqq version --json
```

`dist.attestations` 存在即该版本经 OIDC 发布并带 provenance（来源 commit 与
workflow 可在 npmjs.com 包页面核验）。

## 5. 补发 / 失败处理

- **publish 失败**：重跑 `workflow_dispatch`（changeset 已被消费时置
  `skip-version=true`），registry 比对会只发剩下的版本。不要手动 `npm publish`。
- **ENEEDAUTH `need auth`**：OIDC 模式下**不代表没登录**。npm 用 id_token 换包级
  token，每个失败分支都只写 verbose 日志，然后静默退回无凭证发布。发布步骤已设
  `NPM_CONFIG_LOGLEVEL=verbose`，日志里看
  `POST 404 .../oidc/token/exchange/package/<包名>`：
  - 404 = 该包没有匹配的信任配置（没配 / claim 不符 / 已过期）→ 按 §3.3 补配，
    当天重跑。
  - 其他 = 探测 / 网络问题，看 npm 打印的原始错误。
- **E409 `Cannot publish over previously staged version`**：该版本在 npm 暂存区
  等待批准（暂存版本不在 registry 的 versions 列表里，重跑必然再 409）。到
  npmjs.com 的 Staged Packages 批准或拒绝，或 `npm stage list/approve/reject`
  （npm ≥ 11.15）。
- **E422 `Failed to validate repository information`**：provenance 会校验
  package.json 的 `repository.url` 与 OIDC 来源仓库一致。新增包必须带
  `repository`（`type` / `url` / `directory`），否则 registry 在 PUT 阶段回 422
  （2026-10-21 首次 OIDC 发布即此，PR #9 已给 7 个包补齐）。GitHub 仓改名 /
  转移 owner 后要同步更新 package.json 的 repository URL。
- **202 异步处理**：`npm publish` 成功可能只是 registry 的 202「processing」，
  版本要几分钟才在 registry 可见。刚发完 `npm view` 404 属正常，不要立刻重发
  （重发会被 registry 比对跳过）。复核用
  `https://registry.npmjs.org/<包名>/<版本>`（版本端点比 packument 的 CDN 缓存新）。
- **artifact 过期**：审批拖过 30 天导致 publish 取不到产物时，用
  `skip-version=true` 重跑（版本已在 main，只需重新构建与发布）。

## 6. 本地应急发布

`pnpm release`（= `release:version` + `release:build` + `release:publish`）仍保留，
走本机 npm 登录态 + 2FA（`--otp=` / `NAPKETTO_NPM_OTP`）。仅用于演练与排查；
正常发布不要用它——它绕过了 environment 审批与 OIDC 的信任链。本地做打包检查用
`pnpm release:dryrun`。

## 7. 安全边界

- 发布权 = 「谁能让 `release.yml` 在 main 上跑起来」。改 `.github/workflows/**`、
  `tooling/release/**`、`.changeset/**` 等于改发布权，CODEOWNERS 已覆盖。
- `publish` job 的 `id-token: write` 不可下放到 `prepare`；`environment: release`
  不可删（npm 的 claim 会校验，且它是「合并 ≠ 上线」的唯一保证）。
- GitHub App 的 bypass 是整套规则集的豁免，不是单条规则；它的私钥只应存在于
  Actions secret。
