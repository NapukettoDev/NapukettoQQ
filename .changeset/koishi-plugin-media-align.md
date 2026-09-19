---
"koishi-plugin-adapter-napuketto": patch
---

fix(deps): @napuketto/media ~0.0.2 → ~0.0.4——修复收方向语音解码与生产加载

- media 旧范围钉死漏掉 0.0.3 / 0.0.4：0.0.3 补 CJS 入口（koishi 适配器生产加载报 ERR_PACKAGE_PATH_NOT_EXPORTED）；0.0.4 新增 decodeSilkToWav（插件 voice-decode 直接 import，旧范围下生产环境收方向语音解码不可用）
- @napuketto/adapter ~0.3.1、@napuketto/loader ~0.0.34 相对已发 0.0.32 前移（发布后的依赖刷新入库）
- @koishijs/plugin-console 改声明为 peerDependencies、@koishijs/client 移入 devDependencies（依赖整理；koishi 宿主常驻 console，不新增安装负担）
