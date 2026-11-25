// biome-ignore-all lint/style/useNamingConvention: kernel 导出名即宿主契约。
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const trace = (name) => appendFileSync(process.env.NAPUKETTO_TEST_TRACE, `${name}\n`);
const session = { getMsgService: () => ({}) };
let attempts = 0;
let online = 0;

export function dlopenWrapper() {
    trace("kernel-load");
    return {};
}

export function activateO3MiscService() {
    trace("o3-activate");
    return true;
}

export class NapukettoCore {
    static create({ consoleLog }) {
        if (consoleLog !== false) {
            throw new Error("expected IPC console logs off");
        }
        return {
            attachWrapper: () => {
                trace("attach-wrapper");
                return { session, engine: {}, wrapper: { loginService: {} } };
            },
            login: async () => {
                attempts++;
                if (attempts === 1 && process.env.NAPUKETTO_TEST_HOLD_LOGIN === "1") {
                    return await new Promise(() => undefined);
                }
                return {
                    uin: attempts === 1 ? "10001" : "20002",
                    uid: `fixture-${attempts}`,
                    nick: "测试",
                };
            },
            refreshQr: () => true,
        };
    }
}

export const resolveAppidQua = () => ({ appid: "test", qua: "test" });
export const listLoginAccounts = async () => [];
export const waitSessionReady = async () => undefined;

export class NTEventChannel {
    on() {
        return () => trace("listener-off");
    }
    onAny() {
        return () => trace("forwarding-off");
    }
}

class Bridge {
    register() {
        /* 记录夹具无需原生订阅。 */
    }
    unregister() {
        trace("bridge-off");
    }
}

class Cache extends Bridge {
    unregister() {
        trace("cache-off");
    }
}

class Api {}

export class MsgApi {
    async setOnlineStatus() {
        online++;
        if (online > 1) {
            const resume = join(dirname(process.env.NAPUKETTO_TEST_TRACE), "resume-online");
            while (!existsSync(resume)) {
                await delay(10);
            }
        }
    }
}

export {
    Api as FlashTransferApi,
    Api as FriendApi,
    Api as GroupApi,
    Api as GroupNotifyApi,
    Api as ProfileApi,
    Api as ProfileLikeApi,
    Api as RecentContactApi,
    Api as RichMediaApi,
    Api as TicketApi,
    Api as WebApi,
    Bridge as FriendBridge,
    Bridge as GroupBridge,
    Bridge as LoginBridge,
    Bridge as MsgBridge,
    Bridge as RecentContactBridge,
    Cache as BuddyCache,
    Cache as GroupCache,
};
