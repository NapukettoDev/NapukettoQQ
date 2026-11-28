import type { prepareSelfHost } from "../../../../kernel/src/index.js";
import type { KernelLike } from "../../../src/host/runtime/types.js";

type ExpectHost<T extends KernelLike["prepareSelfHost"]> = T;

export type KernelHostContract = ExpectHost<typeof prepareSelfHost>;
