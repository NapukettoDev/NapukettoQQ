/**
 * Satori 登录动作：login.get
 */
import { z } from "zod";
import type { SatoriApi } from "../api/satori-api.js";
import { toLogin } from "../helper/index.js";
import type { Login } from "../types/index.js";
import { BaseSatoriAction } from "./base-action.js";

/** login.get 参数（无）。 */
const loginGetSchema = z.object({});

/** 动作依赖。 */
export type LoginActionDeps = Pick<SatoriApi, "self">;

/** 获取登录信息。 */
export class LoginGetAction extends BaseSatoriAction<z.infer<typeof loginGetSchema>, Login> {
    readonly name = "login.get";
    readonly schema = loginGetSchema;
    private readonly deps: LoginActionDeps;

    constructor(deps: LoginActionDeps) {
        super();
        this.deps = deps;
    }

    protected async _handle(_payload: z.infer<typeof loginGetSchema>): Promise<Login> {
        return toLogin(this.deps.self, 0, true);
    }
}
