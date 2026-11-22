import type { MediaOutboundPolicy } from "@napuketto/media";
import { z } from "zod";

export const protocolMediaSchema = z.object({
    outboundPolicy: z.enum(["public-only", "compat"] satisfies MediaOutboundPolicy[]).optional(),
});
