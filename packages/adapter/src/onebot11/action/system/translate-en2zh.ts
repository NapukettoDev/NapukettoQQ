/**
 * translate_en2zh 动作：英文单词翻译（P2-14 接 kernel RichMediaApi.translateWords）
 */
import type { RichMediaApi } from "@napuketto/kernel";
import { z } from "zod";
import { BaseAction } from "../../../core/index.js";
import { ob11ErrorCodeMap } from "../error-map.js";
import { MAX_TRANSLATE_WORDS } from "../limits.js";

const translateEn2ZhSchema = z.object({
    // 上界见 action/limits.ts：第三方可直接 POST，词条数组不能无界
    words: z.array(z.string()).max(MAX_TRANSLATE_WORDS),
});

type TranslateEn2ZhPayload = z.infer<typeof translateEn2ZhSchema>;

/** 英文单词翻译（P2-14）。 */
export class TranslateEn2ZhAction extends BaseAction<TranslateEn2ZhPayload, { words: string[] }> {
    readonly name = "translate_en2zh";
    readonly schema = translateEn2ZhSchema;
    protected readonly errorCodeMap = ob11ErrorCodeMap;

    private readonly richMediaApi: RichMediaApi;

    constructor(richMediaApi: RichMediaApi) {
        super();
        this.richMediaApi = richMediaApi;
    }

    protected async _handle(payload: TranslateEn2ZhPayload): Promise<{ words: string[] }> {
        const words = await this.richMediaApi.translateWords(payload.words);
        return { words };
    }
}
