/**
 * @napuketto/adapter milky 子路径入口（ADR-014）
 *
 * Milky 协议适配器（P0）：NapukettoMilkyAdapter + milkyConfigSchema。
 * 装配方（loader assemble-protocols）动态 import 本入口。
 */
export { type MilkyAdapterOptions, NapukettoMilkyAdapter } from "./adapter.js";
export { type MilkyConfig, milkyConfigSchema } from "./config.js";
