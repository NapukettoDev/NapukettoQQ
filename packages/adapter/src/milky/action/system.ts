/**
 * Milky 系统类动作：get_login_info / get_impl_info
 *
 * get_impl_info 是 Milky 的版本协商面（规范 §compatibility）：milky_version
 * 固定 "1.3"（目标协议版本 1.3.0），qq_protocol_type 固定 windows（自建宿主）。
 */
import { z } from "zod";
import type { MilkyApi } from "../api.js";
import type { GetImplInfoOutput, GetLoginInfoOutput } from "../types.js";
import { defineMilkyAction, type MilkyAction } from "./base-action.js";

/** Milky 协议版本（docs/protocols/milky.md：目标 1.3.0）。 */
const MILKY_VERSION = "1.3";

/** 系统类动作工厂（login_info / impl_info）。 */
export function createSystemActions(api: MilkyApi): MilkyAction[] {
    return [
        defineMilkyAction({
            name: "get_login_info",
            schema: z.object({}).strict(),
            handle: async (): Promise<GetLoginInfoOutput> => ({
                uin: Number(api.self.uin),
                nickname: api.self.nickname,
            }),
        }),
        defineMilkyAction({
            name: "get_impl_info",
            schema: z.object({}).strict(),
            handle: async (): Promise<GetImplInfoOutput> => ({
                impl_name: "napukettoqq",
                impl_version: api.implVersion,
                qq_protocol_version: api.qqVersion,
                qq_protocol_type: "windows",
                milky_version: MILKY_VERSION,
            }),
        }),
    ];
}
