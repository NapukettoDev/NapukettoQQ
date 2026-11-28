import type { CanonicalElement } from "@napuketto/kernel";

/** 单次消息准备的累计媒体用量。 */
export interface Ob11MessageMediaStats {
    readonly items: number;
    readonly totalBytes: number;
    readonly peakBytes: number;
    readonly copiedBytes: number;
    readonly downloadedBytes: number;
    readonly transcodedBytes: number;
    readonly reusedReferenceBytes: number;
    readonly tempFilesCreated: number;
}

export interface Ob11MessageMediaPreparation {
    elements: CanonicalElement[];
    stats: Ob11MessageMediaStats;
}

export type Ob11MessageMediaObserver = (stats: Ob11MessageMediaStats) => void | Promise<void>;
