/**
 * Milky inbound 领域处理器共享装配参数（adapter 注入；各域 deps 按需取用，
 * 经类型别名追加 enrich / essence 等共享实例）。处理器装配归 adapter。
 */
import type { MilkyApi } from "../api.js";
import type { MessageSeqIndex } from "../helper/state/seq-index.js";
import type { MilkyLoggerLike } from "../transport.js";

export interface MilkyInboundBase {
    api: MilkyApi;
    seqIndex: MessageSeqIndex;
    broadcast: (event: unknown) => void;
    logger?: MilkyLoggerLike | undefined;
}
