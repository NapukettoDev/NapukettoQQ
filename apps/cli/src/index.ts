#!/usr/bin/env node

/**
 * @napuketto/cli 入口（P2-6 + P6，2026-08-05；2026-08-07 用户拍板：只保留自建宿主；
 * 2026-08-08 配置结构拍板：账号必填，协议配置嵌在账号内）
 *
 * commander 参数解析：
 *   - 单账号：-q <uin> → runSingleAccount（自建宿主：标准 node + stub QQNT.dll，不拉起 QQ）
 *   - 多账号：-q A -q B 或 supervisor 子命令 → runSupervisor（子进程编排）
 *   - 无 -q：读全局配置 accounts（至少一个，账号必填）→ supervisor 拉起全部启用账号
 *   - config 子命令：init / list / apply / validate（主配置管理）
 *   - 退出码契约（2026-10-25）：0 = 请求式优雅关停；78 = 配置校验失败（ConfigError
 *     一族，宿主消费，免重启）；其余错误 = 1（handleActionError 统一出口）
 *
 * 路线 B（拉起 QQ + 注入）已淘汰（2026-08-07 用户拍板），相关入口已移除。
 *
 * 2026-10-25 模块收拢：本文件只保留进程入口；commander 装配在 cli/program.ts，
 * 用例在 commands/，配置领域在 config/，运行期在 runtime/。
 */
import { main } from "./cli/program.js";

main();
