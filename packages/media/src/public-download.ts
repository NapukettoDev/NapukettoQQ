import { lookup } from "node:dns/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet, type RequestOptions } from "node:https";
import { BlockList, isIP, type LookupFunction, type TcpNetConnectOpts } from "node:net";
import type { DownloadRequest, DownloadResponse } from "./downloader.js";
import { MediaError } from "./types.js";

const ADDRESS_BRACKETS = /^\[|\]$/g;
const IPV4_MAPPED = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/;

const SPECIAL_IPV4 = new BlockList();
for (const [address, prefix] of [
    ["10.0.0.0", 8],
    ["127.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
] as const) {
    SPECIAL_IPV4.addSubnet(address, prefix);
}

const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");
const SPECIAL_IPV6 = new BlockList();
for (const [address, prefix] of [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
] as const) {
    SPECIAL_IPV6.addSubnet(address, prefix, "ipv6");
}

function assertPublicAddress(host: string): void {
    const mapped = IPV4_MAPPED.exec(host);
    if (mapped?.[1] !== undefined && mapped[2] !== undefined) {
        const high = Number.parseInt(mapped[1], 16);
        const low = Number.parseInt(mapped[2], 16);
        assertPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
        return;
    }
    const family = isIP(host);
    const allowed =
        family === 4
            ? !SPECIAL_IPV4.check(host)
            : family === 6 &&
              !host.includes("%") &&
              GLOBAL_IPV6.check(host, "ipv6") &&
              !SPECIAL_IPV6.check(host, "ipv6");
    if (!allowed) {
        throw new MediaError("公网下载策略拒绝目标地址");
    }
}

/** 将通过校验的系统解析结果直接交给当前 socket。 */
function publicLookup(checkLiteral: (url: string) => URL, signal: AbortSignal): LookupFunction {
    return (hostname, options, callback) => {
        lookup(hostname, { all: true })
            .then((addresses) => {
                signal.throwIfAborted();
                const first = addresses[0];
                if (first === undefined) {
                    throw new MediaError("公网下载目标没有可用地址");
                }
                for (const { address, family } of addresses) {
                    const url = checkLiteral(`http://${family === 6 ? `[${address}]` : address}`);
                    assertPublicAddress(url.hostname.replace(ADDRESS_BRACKETS, ""));
                }
                return { addresses, first };
            })
            .then(
                ({ addresses, first }) => {
                    if (options.all) {
                        callback(null, addresses);
                    } else {
                        callback(null, first.address, first.family);
                    }
                },
                (error: Error) => callback(error, "", 0),
            )
            .catch((error: Error) => callback(error, "", 0));
    };
}

export function createPublicRequest(checkLiteral: (url: string) => URL): DownloadRequest {
    return async (url, signal, headers) => {
        if (url.username !== "" || url.password !== "") {
            throw new MediaError("公网下载策略拒绝 URL 凭据");
        }
        const host = url.hostname.replace(ADDRESS_BRACKETS, "");
        if (isIP(host) !== 0) {
            assertPublicAddress(host);
        }
        const get = url.protocol === "https:" ? httpsGet : httpGet;
        const options: RequestOptions & Pick<TcpNetConnectOpts, "autoSelectFamily"> = {
            agent: false,
            rejectUnauthorized: true,
            signal,
            autoSelectFamily: true,
            headers: { ...headers, "accept-encoding": "identity" },
            lookup: publicLookup(checkLiteral, signal),
        };
        return new Promise<DownloadResponse>((resolve, reject) => {
            const request = get(url, options, (response) => {
                const status = response.statusCode ?? 0;
                const encoding = response.headers["content-encoding"];
                if (
                    status >= 200 &&
                    status < 300 &&
                    encoding &&
                    encoding.toLowerCase() !== "identity"
                ) {
                    response.destroy();
                    reject(new MediaError("公网下载响应使用了不支持的内容编码"));
                    return;
                }
                resolve({
                    status,
                    headers: {
                        get: (name) => response.headers[name.toLowerCase()]?.toString() ?? null,
                    },
                    body: response,
                });
            });
            request.once("error", reject);
        });
    };
}
