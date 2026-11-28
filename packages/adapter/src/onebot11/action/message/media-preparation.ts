import { stat } from "node:fs/promises";
import type { CanonicalElement } from "@napuketto/kernel";
import { kernelError } from "@napuketto/kernel";
import {
    DEFAULT_DOWNLOAD_MAX_BYTES,
    extractVideoFrame,
    getImageSize,
    getVideoInfo,
    inferExtension,
    MediaSizeLimitError,
} from "@napuketto/media";
import {
    downloadProtocolMedia,
    ensureSilk,
    prepareImageElements,
    prepareVideoThumbnail,
} from "../../../internal/domain/media.js";
import { resolveLocalMedia } from "../../../internal/infra/local-media.js";
import { cacheMediaFile, MEDIA_TEMP_ROOT } from "../../../internal/infra/media-cache.js";
import type { OneBotApi } from "../../api/onebot-api.js";
import type { Ob11MessageMediaBudgetConfig } from "../../helper/config.js";
import type { Ob11MessageMediaPreparation, Ob11MessageMediaStats } from "../../types/media.js";

const DEFAULT_MAX_ITEMS = 16;
const DEFAULT_MAX_BYTES = 120 * 1024 * 1024;
const HTTP_MEDIA_RE = /^https?:/i;

type MediaDeps = Pick<OneBotApi, "getLocalMediaRoots" | "getMediaOutboundPolicy" | "logger">;
type MediaElement = Extract<CanonicalElement, { type: "image" | "voice" | "video" }>;
type MediaByteKind = "copiedBytes" | "downloadedBytes" | "transcodedBytes" | "reusedReferenceBytes";
type MutableMediaStats = {
    -readonly [Key in keyof Ob11MessageMediaStats]: Ob11MessageMediaStats[Key];
};

function isMediaElement(el: CanonicalElement): el is MediaElement {
    return el.type === "image" || el.type === "voice" || el.type === "video";
}

function countMediaItems(elements: readonly CanonicalElement[]): number {
    let items = 0;
    for (const el of elements) {
        if (isMediaElement(el)) items += el.type === "video" && el.thumbPath !== undefined ? 2 : 1;
    }
    return items;
}

class MediaLedger {
    readonly stats: MutableMediaStats;
    private readonly maxBytes: number;
    private retainedBytes = 0;

    constructor(items: number, maxBytes: number) {
        this.maxBytes = maxBytes;
        this.stats = {
            items,
            totalBytes: 0,
            peakBytes: 0,
            copiedBytes: 0,
            downloadedBytes: 0,
            transcodedBytes: 0,
            reusedReferenceBytes: 0,
            tempFilesCreated: 0,
        };
    }

    get remainingBytes(): number {
        return this.maxBytes - this.stats.totalBytes;
    }

    record(kind: MediaByteKind, bytes: number, retained = true): void {
        if (bytes > this.remainingBytes) throw kernelError("媒体超过消息字节预算", "INVALID_PARAM");
        this.stats.totalBytes += bytes;
        this.stats[kind] += bytes;
        if (kind === "reusedReferenceBytes") return;
        this.stats.tempFilesCreated += 1;
        this.stats.peakBytes = Math.max(this.stats.peakBytes, this.retainedBytes + bytes);
        if (retained) this.retainedBytes += bytes;
    }

    async recordFile(kind: "downloadedBytes" | "transcodedBytes", path: string): Promise<string> {
        this.record(kind, (await stat(path)).size);
        return path;
    }
}

async function prepareInput(input: string, deps: MediaDeps, ledger: MediaLedger): Promise<string> {
    if (!HTTP_MEDIA_RE.test(input)) {
        return await resolveLocalMedia(input, deps.getLocalMediaRoots?.(), {
            maxBytes: ledger.remainingBytes,
            onPrepared: (kind, bytes) => ledger.record(kind, bytes),
        });
    }
    const path = await cacheMediaFile(MEDIA_TEMP_ROOT, inferExtension(null, input), (target) =>
        downloadProtocolMedia(input, target, {
            outboundPolicy: deps.getMediaOutboundPolicy?.(),
            maxBytes: Math.min(DEFAULT_DOWNLOAD_MAX_BYTES, ledger.remainingBytes),
        }),
    );
    return await ledger.recordFile("downloadedBytes", path);
}

async function prepareElement(
    el: MediaElement,
    deps: MediaDeps,
    ledger: MediaLedger,
): Promise<CanonicalElement> {
    const path = await prepareInput(el.path, deps, ledger);
    if (el.type === "voice") {
        const silk = await ensureSilk(path, deps.logger, {
            maxOutputBytes: ledger.remainingBytes,
            onPcmWritten: (bytes) => ledger.record("transcodedBytes", bytes, false),
        });
        if (silk !== path) await ledger.recordFile("transcodedBytes", silk);
        return { ...el, path: silk };
    }
    if (el.type !== "video") return { ...el, path };
    if (el.thumbPath !== undefined) {
        const thumbPath = await prepareInput(el.thumbPath, deps, ledger);
        const [size, info] = await Promise.all([getImageSize(thumbPath), getVideoInfo(path)]);
        return {
            ...el,
            path,
            thumbPath,
            width: el.width ?? size.width,
            height: el.height ?? size.height,
            durationSec: el.durationSec ?? Math.max(1, Math.round(info.durationMs / 1000)),
        };
    }
    return await prepareVideoThumbnail({ ...el, path }, async (input) => {
        const thumb = await cacheMediaFile(MEDIA_TEMP_ROOT, ".png", (target) =>
            extractVideoFrame(input, target, { maxOutputBytes: ledger.remainingBytes }),
        );
        return await ledger.recordFile("transcodedBytes", thumb);
    });
}

export async function prepareOb11MessageMedia(
    elements: readonly CanonicalElement[],
    deps: MediaDeps,
    config?: Ob11MessageMediaBudgetConfig,
): Promise<Ob11MessageMediaPreparation> {
    const items = countMediaItems(elements);
    const maxItems = config?.maxItems ?? DEFAULT_MAX_ITEMS;
    if (items > maxItems) throw kernelError(`消息媒体项数超过 ${maxItems}`, "INVALID_PARAM");
    const ledger = new MediaLedger(items, config?.maxBytes ?? DEFAULT_MAX_BYTES);
    const prepared: CanonicalElement[] = [];
    try {
        for (const el of elements) {
            prepared.push(isMediaElement(el) ? await prepareElement(el, deps, ledger) : el);
        }
    } catch (err) {
        if (err instanceof MediaSizeLimitError) {
            throw kernelError(err.message, "INVALID_PARAM", { cause: err });
        }
        throw err;
    }
    return { elements: await prepareImageElements(prepared, deps.logger), stats: ledger.stats };
}
