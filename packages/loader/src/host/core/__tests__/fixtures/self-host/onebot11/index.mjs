// biome-ignore-all lint/style/useNamingConvention: adapter 导出名即宿主契约。
import { appendFileSync } from "node:fs";

export const ob11ConfigSchema = { parse: () => ({}) };

export class NapukettoOneBot11Adapter {
    constructor({ system }) {
        this.registry = {
            names: ["bot_exit", "wait_forever"],
            get: (name) => ({
                handle:
                    name === "bot_exit"
                        ? system.exit
                        : async () => await new Promise(() => undefined),
            }),
        };
    }

    async subscribeOnly() {
        appendFileSync(process.env.NAPUKETTO_TEST_TRACE, "protocol-start\n");
    }

    unsubscribeOnly() {
        appendFileSync(process.env.NAPUKETTO_TEST_TRACE, "protocol-stop\n");
    }
}
