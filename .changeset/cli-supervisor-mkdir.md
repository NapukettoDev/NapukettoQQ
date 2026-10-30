---
"@napuketto/cli": patch
---

fix(cli): 首次 start 时 supervisor.json 写入自动创建数据根

writeSupervisorRuntime 此前不建目录，在全新目录（无 .napuketto）执行
napuketto start 直接 ENOENT 退出。对齐 writeAccountRuntime 的行为：写入前
mkdirSync(recursive)。
