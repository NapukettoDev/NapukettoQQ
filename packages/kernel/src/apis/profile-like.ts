/**
 * ProfileLikeApi：资料点赞语义化 API（ADR-009 统一错误语义，P2-14）
 *
 * sendLike：send_like（sourceId=71 赞来源，doLikeCount 次数）。
 */
import { kernelError } from "../infra/index.js";
import type { NodeIKernelProfileLikeService, NodeIQQNTWrapperSession } from "../types/index.js";
import { requireKernelService } from "../utils/type-guards.js";

/** 点赞 API：从 session 拿 profile like service，包装成语义化方法。 */
export class ProfileLikeApi {
    private readonly service: NodeIKernelProfileLikeService;

    constructor(session: NodeIQQNTWrapperSession) {
        this.service = requireKernelService(
            session.getProfileLikeService(),
            "getProfileLikeService",
            ["setBuddyProfileLike"],
        );
    }

    /** 点赞（send_like；uid 为目标 uid，count 次数）。 */
    async sendLike(uid: string, count = 1): Promise<void> {
        const raw = await this.service.setBuddyProfileLike({
            friendUid: uid,
            sourceId: 71,
            doLikeCount: count,
            doLikeTollCount: 0,
        });
        if (raw.result !== 0) {
            throw kernelError(`点赞失败: ${raw.errMsg}`, "UNKNOWN");
        }
    }
}
