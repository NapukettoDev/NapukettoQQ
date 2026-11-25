#!/usr/bin/env node

/**
 * @napuketto/cli 进程入口：唯一启动路径是自建宿主（标准 node + stub QQNT.dll），不拉起 QQ。
 * 无 -q 时读全局配置 accounts（账号必填，协议嵌在账号内）拉起全部启用账号。
 * 退出码契约（0 / 78 / 1）见 cli/error.ts。
 */
import { main } from "./cli/program.js";

main();
