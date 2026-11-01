---
"@napuketto/adapter": patch
---

fix(adapter): milky HTTP 传输从未监听——startTransports 缺 open（P0 起存量）

置顶翻转校准实验（milky.md §0.8.5 批次三前置）首次实机启用 `[accounts.milky]`
段发现：`bootstrap: milky adapter started` 但端口从未绑定——
`startTransports` 装配传输后**没有调 `open()`**（satori 在 P0 同期写对了：
`Promise.all(adapters.map((t) => t.open()))`；OB11 也在 startTransports 里
显式 open）。集成测试一直显式 `set.adapters[0]?.open()` 自己补了 listen，
掩盖了适配器路径的缺口。

修复：startTransports 装配后 `Promise.all(set.adapters.map((a) => a.open()))`
——server.open 实绑端口，hub / webhook client 的 open 均为 no-op。
适配器级回归测试：NapukettoMilkyAdapter.start() 后直接 fetch
/api/get_impl_info 可达（旧代码 ECONNREFUSED）。
