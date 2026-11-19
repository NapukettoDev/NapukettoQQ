# PR 说明（发布）

> 标题 `build(release): ……`；本模板只管发布链与发布面字段——真正发版由 release.yml 消费 changeset 自动完成，不走 PR。空章节写「无」。

## 1. 改了什么

<!-- 改的是发布链哪一环（consume changeset / build / pack 守卫 / test / tag+push / npm publish）、changesets 配置，还是某包的发布面字段。 -->

## 2. 发布面影响

- 涉及包（包名 → 是否可发布 → 是否需要与其依赖一起升版）：
- 影响的字段：files / exports / main / types / bin / peerDependencies / publishConfig
- 是否影响 `@napuketto/loader` 的 native 产物入包（`native/prebuilt/win32-x64/QQNT.dll`、`native/prebuilt/linux-x64/libnapuketto_stub.so`）：
- 是否影响镜像链（`image.yml` 按 `@napuketto/cli@<版本>` tag 触发，等 npm 就绪后构建 full / slim 两个变体）：
- 是否需要先于其它包发布（拓扑顺序约束）：

## 3. 验证

- [ ] `pnpm check` 全绿（biome + tsc）
- [ ] `pnpm test` 全绿（发布链代码有既有回归用例：`tooling/release/__tests__/`）
- [ ] `pnpm -r build` 通过
- [ ] `pnpm release:dryrun` 走通（升版本 + 构建 + registry 比对，不真正发包）
- [ ] 改动 files / exports / bin 时做打包预演：`packages/loader` 内 `npm pack --dry-run 2>&1`，核对 DLL / `.so` 是否真的进清单（files 匹配不到文件时 npm 静默丢件）
- [ ] 退路核对：本次改动若把发布卡在 publish 审批之后，`workflow_dispatch` 的 `skip-version` 补发通道仍可用

## 4. changeset

<!-- 发布链 / 配置类改动通常「无」；若顺带改了包行为，按对应领域模板说明。注意版本提交由流水线产生，不要手工改包版本号。 -->

- 无

## 5. 影响面与风险

<!-- 发布面回归的后果（下游解析失败 / 缺原生产物 / 镜像跑不起来）、发布链幂等性是否仍成立、
     需要的仓库前置（App、environment、npm 信任配置）是否变化、回滚方式与是否需要补发。 -->

## 6. 关联

<!-- 相关事故记录 / run 链接、相关 issue；无则写「无」。 -->
