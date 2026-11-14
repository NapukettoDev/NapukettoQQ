/**
 * Satori 登录动作：login.get
 */
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { toLogin } from "../helper/index.js";
import type { Login } from "../types/index.js";
import { defineSatoriAction, type SatoriAction } from "./base-action.js";

/** 动作依赖。 */
export type LoginActionDeps = Pick<SatoriApi, "self">;

/** 登录动作工厂（login.get）。 */
export function createLoginActions(deps: LoginActionDeps): SatoriAction[] {
    return [
        defineSatoriAction({
            name: "login.get",
            schema: z.object({}),
            handle: async (): Promise<Login> => toLogin(deps.self, 0, true),
        }),
    ];
}
