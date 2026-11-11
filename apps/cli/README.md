# @napuketto/cli

NapukettoQQ 命令行入口。

```bash
napuketto                  # 启动：自动登录（快速/扫码）→ 按账号配置装配协议服务
napuketto -q <QQ号>        # 指定账号快速登录
napuketto -q A -q B        # 多账号 supervisor 编排
napuketto supervisor       # 读全局配置 accounts 拉起多账号子进程
napuketto config init      # 生成默认全局配置（napuketto.toml）
napuketto config list      # 列出全局配置与账号配置
napuketto config apply <file>  # 应用外部配置（校验后写回）
```

常用选项：`-d, --data-dir <dir>` 数据根目录（缺省 `<项目根>/.napuketto`）；`--stub-dir <dir>` stub QQNT.dll 目录。
