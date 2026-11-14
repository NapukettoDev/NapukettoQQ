/**
 * kurobot inbound 服务端帧域：服务端帧 → 模板渲染回群文本、status 快照缓存、
 * 绑定集维护（bindings_updated / query_result）、command_result 关联回发群。
 * 共享状态在 session.ts。
 */
import { ChatType } from "@napuketto/kernel";
import type { KurobotMsgApi } from "../adapter.js";
import type { KurobotConfig } from "../config.js";
import type { KurobotConnectionOptions, ServerEventMessage } from "../connection.js";
import type { KurobotSession } from "../session.js";
import {
    renderCommandResult,
    renderDeathText,
    renderTemplate,
    truncateForGroup,
} from "../translate.js";

export interface KurobotServerFrameDeps {
    msgApi: KurobotMsgApi;
    requireConfig: () => KurobotConfig;
    session: KurobotSession;
    logger?: KurobotConnectionOptions["logger"] | undefined;
}

export class KurobotServerFrameHandler {
    private readonly msgApi: KurobotMsgApi;
    private readonly requireConfig: () => KurobotConfig;
    private readonly session: KurobotSession;
    private readonly log: KurobotConnectionOptions["logger"];

    constructor(deps: KurobotServerFrameDeps) {
        this.msgApi = deps.msgApi;
        this.requireConfig = deps.requireConfig;
        this.session = deps.session;
        this.log = deps.logger;
    }

    /** 服务端帧分发（未知事件帧忽略，连接层已滤）。 */
    handle(msg: ServerEventMessage): void {
        switch (msg.type) {
            case "pong": // 心跳响应不需要处理（收不到就等服务端 1001 关闭走重连）
                return;
            case "chat":
                this.sendToGroup(
                    msg.body.channel,
                    renderTemplate(this.requireConfig().chatTemplate, {
                        player: msg.body.playerName,
                        content: msg.body.content,
                    }),
                );
                return;
            case "join":
            case "leave": {
                const config = this.requireConfig();
                const template = msg.type === "join" ? config.joinTemplate : config.leaveTemplate;
                this.sendToGroup(
                    msg.body.channel,
                    renderTemplate(template, { player: msg.body.playerName }),
                );
                return;
            }
            case "death":
                this.sendToGroup(
                    msg.body.channel,
                    truncateForGroup(
                        renderDeathText(
                            this.requireConfig().deathTemplate,
                            msg.body.player,
                            msg.body.message,
                        ),
                    ),
                );
                return;
            case "status":
                this.session.applyStatus(msg.body); // 仅缓存不发群（防刷屏）
                return;
            case "bindings_updated":
                this.session.applyBindings(msg.body.channelBindings);
                this.log?.info({ bindings: msg.body.channelBindings }, "kurobot: 绑定表已更新");
                return;
            case "command_result": {
                const channel = this.session.takeCommand(msg.id);
                if (channel === undefined) {
                    this.log?.warn({ id: msg.id }, "kurobot: command_result 无对应请求，丢弃");
                    return;
                }
                this.sendToGroup(channel, truncateForGroup(renderCommandResult(msg.body)));
                return;
            }
            case "query_result":
                this.session.applyQueryResult(msg.id, msg.body);
                return;
        }
    }

    /** 群文本发送（失败 error 日志不抛出——不影响连接与收链路）。 */
    private sendToGroup(channel: string, text: string): void {
        this.msgApi
            .sendMessage({ chatType: ChatType.GROUP, peerUid: channel }, [{ type: "text", text }])
            .then(() => {
                this.log?.debug({ channel }, "kurobot: 群消息已发送");
            })
            .catch((err: unknown) => {
                this.log?.error(
                    { channel, err: err instanceof Error ? err.message : String(err) },
                    "kurobot: 群消息发送失败",
                );
            });
    }
}
