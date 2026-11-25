/**
 * NodeIKernelTicketService：票据服务接口面（自研描述，非移植）。
 * 依据运行时反射 + wrapper 外部契约（接口签名是 QQ 的外部事实，零复制）；
 * forceFetchClientKey 是唯一对外常用方法（get_clientkey / get_cookies 共用）。
 */
import type { GeneralCallResult } from "./msg-service.js";

/** forceFetchClientKey 返回（get_clientkey 直接返回，get_cookies 用 clientKey 换跳转票据）。 */
export interface ForceFetchClientKeyRetType extends GeneralCallResult {
    url: string;
    keyIndex: string;
    clientKey: string;
    expireTime: string;
}

/** 票据服务。 */
export interface NodeIKernelTicketService {
    addKernelTicketListener(listener: unknown): number;
    removeKernelTicketListener(listenerId: number): void;
    forceFetchClientKey(arg: string): Promise<ForceFetchClientKeyRetType>;
    isNull(): boolean;
}
