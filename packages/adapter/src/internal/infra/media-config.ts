import type { MediaOutboundPolicy } from "@napuketto/media";
import { z } from "zod";

export const protocolMediaSchema = z.object({
    localMediaRoots: z.array(z.string().min(1)).optional(),
    outboundPolicy: z.enum(["public-only", "compat"] satisfies MediaOutboundPolicy[]).optional(),
});

export type ProtocolMediaConfig = z.infer<typeof protocolMediaSchema>;
