/**
 * Milky 系统类动作（P0）：get_login_info / get_impl_info
 *
 * get_impl_info 是 Milky 的版本协商面（规范 §compatibility）：milky_version
 * 固定 "1.3"（目标协议版本 1.3.0），qq_protocol_type 固定 windows（自建宿主）。
 */
import { z } from "zod";
import type { GetImplInfoOutput, GetLoginInfoOutput } from "../types.js";
import { MilkyApiAction } from "./base-action.js";

/** Milky 协议版本（docs/protocols/milky.md：目标 1.3.0）。 */
const MILKY_VERSION = "1.3";

const emptySchema = z.object({}).strict();

/** get_login_info：获取登录信息。 */
export class GetLoginInfoAction extends MilkyApiAction<Record<string, never>, GetLoginInfoOutput> {
    readonly name = "get_login_info";
    readonly schema = emptySchema;

    protected async _handle(): Promise<GetLoginInfoOutput> {
        return { uin: Number(this.api.self.uin), nickname: this.api.self.nickname };
    }
}

/** get_impl_info：获取协议端信息（版本协商）。 */
export class GetImplInfoAction extends MilkyApiAction<Record<string, never>, GetImplInfoOutput> {
    readonly name = "get_impl_info";
    readonly schema = emptySchema;

    protected async _handle(): Promise<GetImplInfoOutput> {
        return {
            impl_name: "napukettoqq",
            impl_version: this.api.implVersion,
            qq_protocol_version: this.api.qqVersion,
            qq_protocol_type: "windows",
            milky_version: MILKY_VERSION,
        };
    }
}
