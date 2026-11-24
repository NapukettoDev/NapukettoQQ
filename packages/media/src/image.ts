/**
 * 图片与文件识别
 *
 * - `getImageSize`：image-size（读取 Uint8Array，同步计算）
 * - `detectFileType`：file-type（按文件路径检测魔数）
 */
import { fileTypeFromBuffer } from "file-type";
import { imageSize } from "image-size";
import { checkMediaSignal, localMediaPath, readMediaPrefix } from "./process.js";
import type { FileTypeResult, ImageSize, MediaOperationOptions } from "./types.js";
import { MediaError } from "./types.js";

/** 只读取有限的图片头部，尺寸元数据须在前 512 KiB 内。 */
export async function getImageSize(
    input: string,
    { signal }: MediaOperationOptions = {},
): Promise<ImageSize> {
    checkMediaSignal(signal);
    try {
        const buffer = await readMediaPrefix(await localMediaPath(input), 512 * 1024, signal);
        const { width, height } = imageSize(buffer);
        if (
            !Number.isSafeInteger(width) ||
            width <= 0 ||
            !Number.isSafeInteger(height) ||
            height <= 0
        ) {
            throw new MediaError("图片尺寸无效");
        }
        return { width, height };
    } catch (error) {
        checkMediaSignal(signal);
        throw new MediaError(`无法读取图片尺寸: ${input}`, { cause: error });
    }
}

/** 检测文件类型（魔数识别，返回 undefined 时抛 MediaError）。 */
export async function detectFileType(
    input: string,
    { signal }: MediaOperationOptions = {},
): Promise<FileTypeResult> {
    checkMediaSignal(signal);
    try {
        const bytes = await readMediaPrefix(await localMediaPath(input), 1024 * 1024, signal);
        const result = await fileTypeFromBuffer(
            bytes,
            signal === undefined ? undefined : { signal },
        );
        checkMediaSignal(signal);
        if (result !== undefined) return { ext: result.ext, mime: result.mime };
    } catch (error) {
        checkMediaSignal(signal);
        throw new MediaError(`无法识别的文件类型: ${input}`, { cause: error });
    }
    throw new MediaError(`无法识别的文件类型: ${input}`);
}
