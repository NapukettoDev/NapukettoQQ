---
"@napuketto/loader": patch
---

fix(loader): 发布包补上 Linux stub（`native/build/linux-x64`），`NAPUTO_LINUX_NATIVE=1` 不再报 stub 未找到

`files` 此前只列 `native/build/stub-test-env`（Windows `QQNT.dll`），已发布的 0.6.0
tarball 里没有 `libnapuketto_stub.so`——Linux 用户开原生分支会直接命中
「Linux stub 未找到」。现在把 `native/build/linux-x64` 加进白名单，并在发布链与
`tooling/package-exports.test.ts` 各加一道守卫（`npm pack --dry-run` 断言 Linux `.so`
入包 / 断言 `files` 含该目录），防止后续回归。
