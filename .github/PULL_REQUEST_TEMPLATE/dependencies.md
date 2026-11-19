# PR 说明（依赖变更）

> 标题 `chore(deps): ……`；Dependabot 的 PR 也按此填。空章节写「无」。

## 1. 类型与范围

- [ ] 依赖升版（minor / patch）
- [ ] 依赖升版（major，已读过上游 breaking change）
- [ ] 依赖新增 / 移除 / 替换
- [ ] catalog 调整（`pnpm-workspace.yaml` 的 catalog / `minimumReleaseAge` 等）
- [ ] 私有 submodule 指针更新（`packages/loader/native`）

涉及依赖（名 → 旧版本 → 新版本）：

## 2. 改动内容

<!-- 声明位置（哪些 package.json 的 dependencies / devDependencies / catalog:）+ pnpm-lock.yaml 是否随之变化。
     新增依赖写清用途与许可证；移除依赖写清原调用点迁到了哪里。 -->

## 3. 红线与纪律复核

- [ ] 许可证兼容：新增依赖为 MIT 等宽松许可，未引入 GPL-2.0-only 实现（根 AGENTS.md「许可证与子模块」）
- [ ] catalog 内的依赖仍写 `catalog:`，未在单个包内重新写死版本（`tooling/package-exports.test.ts` 强制的回退门禁）
- [ ] 依赖方向未被打穿：`network` 仍协议无关、`media` 未被 `kernel` 触碰
- [ ] 未绕过 `minimumReleaseAge` 冷却期手工改 lockfile 引入刚发布的包
- [ ] 改了 `package.json` / `pnpm-workspace.yaml` / 子模块指针时，`pnpm-lock.yaml` 已一并提交（git hook 强制校验）
- [ ] 未把 workspace 内部包 `@napuketto/*` 的版本改成固定号（由 changesets 联动）

## 4. 验证

- [ ] `pnpm install` 后 `pnpm-lock.yaml` 的 diff 已人工复核（锁文件版本未回退、无意外新增传递依赖）
- [ ] `pnpm audit --prod --audit-level=high` 无新增 high / critical（与 CI 口径一致）
- [ ] `pnpm check` 全绿（biome + tsc）
- [ ] `pnpm test` 全绿
- [ ] `pnpm -r build` 通过
- [ ] `pnpm exec fallow audit --base origin/main` 无新增问题（依赖增删必跑）
- [ ] 行为等价性证据：上游 changelog 要点 / 相关用例 / 关键路径实测

## 5. changeset

<!-- 升版带来下游可见行为变化 → 写条目；纯 devDependencies / 内部工具链 → 「无」。 -->

## 6. 影响面与风险

<!-- 运行时兼容性（Node 24 口径）、产物体积变化、是否需要下游重新安装、submodule 指针是否影响 npm 打包（loader 的 native/prebuilt 必须入包）、回滚方式。 -->

## 7. 关联

<!-- 上游 release / commit / issue 链接、Dependabot PR 编号；无则写「无」。 -->
