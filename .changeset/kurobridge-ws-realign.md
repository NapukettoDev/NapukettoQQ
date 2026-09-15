---
"@napuketto/adapter": patch
"@napuketto/cli": patch
---

fix(adapter): 协议镜像对齐 KuroBridge 改名（kurobridge-ws.v1 / 0.4.0）+ 修复 0.1.18/0.3.0 发布物损坏

- 协议镜像（adapter `schema.ts`）随 KuroAdapter ADR-030 品牌改名对齐：WS 子协议
  `kurobot-ws.v1` → `kurobridge-ws.v1`，PROTOCOL_VERSION 0.3.1 → 0.4.0（帧形状与
  0.3.1 逐字段一致，仅品牌字符串与版本号变更）。**本版起仅与 kurobridge-ws.v1
  服务端（KuroAdapter 改名后版本）互通**；TOML `[accounts.kurobot]` 段名不变。
- 0.1.18 / 0.3.0 的 npm 发布物 manifest 泄漏 `workspace:*`（`npm install` 直接
  EUNSUPPORTEDPROTOCOL，无法安装），两个版本号作废；本版经 pnpm release 链重新
  发布（release-npm 的 workspace 改写兜底覆盖）。
