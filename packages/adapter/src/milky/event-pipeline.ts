/**
 * Milky 收链路订阅接线板：管理 unsubscribes 与 kernel 频道 → 领域处理器路由。
 * 域处理在 inbound/，异步回填在 enrichment.ts（ADR-008），处理器装配归 adapter。
 */
import type {
    BuddyEventChannel,
    GroupEventChannel,
    LoginEventChannel,
    MsgEventChannel,
    RecentContactEventChannel,
} from "@napuketto/kernel";
import { subscribeRawMessages } from "../core/shared/raw-message.js";
import type { MilkyInboundEssence } from "./inbound/essence.js";
import type { MilkyInboundFileNotice } from "./inbound/file-notice.js";
import type { MilkyInboundMessage } from "./inbound/message.js";
import type { MilkyInboundPin } from "./inbound/pin.js";
import type { MilkyInboundRequest } from "./inbound/request.js";
import type { MilkyInboundSysMsg } from "./inbound/sysmsg.js";

export interface MilkyEventPipelineDeps {
    msgChannel: MsgEventChannel;
    groupChannel?: GroupEventChannel | undefined;
    buddyChannel?: BuddyEventChannel | undefined;
    recentContactChannel?: RecentContactEventChannel | undefined;
    loginChannel?: LoginEventChannel | undefined;
    essence: MilkyInboundEssence;
    message: MilkyInboundMessage;
    sysMsg: MilkyInboundSysMsg;
    request: MilkyInboundRequest;
    fileNotice: MilkyInboundFileNotice;
    pin: MilkyInboundPin;
}

export class MilkyEventPipeline {
    private readonly deps: MilkyEventPipelineDeps;
    private unsubscribes: Array<() => void> = [];

    constructor(deps: MilkyEventPipelineDeps) {
        this.deps = deps;
    }

    /** 订阅 kernel 事件（消息 + 群 + 好友 + 批次三，幂等；路由到 inbound/）。 */
    subscribe(): void {
        if (this.unsubscribes.length > 0) {
            return;
        }
        const { msgChannel, groupChannel, buddyChannel, recentContactChannel, loginChannel } =
            this.deps;
        this.unsubscribes.push(
            subscribeRawMessages(msgChannel, (msg) => void this.deps.message.handle(msg)),
            msgChannel.on("Msg/onRecvSysMsg", (a) => this.deps.sysMsg.handleRawArg(a)),
            msgChannel.on("Msg/onRecvOfflineFileMsg", (m) => this.deps.fileNotice.fileMessages(m)),
            msgChannel.on("Msg/onFileMsgCome", (m) => this.deps.fileNotice.fileMessages(m)),
        );
        if (groupChannel !== undefined) {
            this.unsubscribes.push(
                groupChannel.on("Group/onGroupNotifiesUpdated", (doubt, notifies) => {
                    void this.deps.request.groupNotifies(doubt, notifies);
                }),
                groupChannel.on("Group/onGroupEssenceListChange", (a) =>
                    this.deps.essence.change(a),
                ),
            );
        }
        if (buddyChannel !== undefined) {
            this.unsubscribes.push(
                buddyChannel.on("Buddy/onBuddyReqChange", (a) => this.deps.request.buddyReqs(a)),
            );
        }
        if (recentContactChannel !== undefined) {
            this.unsubscribes.push(
                recentContactChannel.on("RecentContact/onRecentContactListChangedVer2", (lists) => {
                    this.deps.pin.handleChanges(lists);
                }),
            );
            this.deps.pin.seed();
        }
        if (loginChannel !== undefined) {
            this.unsubscribes.push(
                loginChannel.on("Login/onLoginDisConnected", (...args) => {
                    this.deps.fileNotice.botOffline("disconnected", args);
                }),
                loginChannel.on("Login/onLogoutSucceed", (...args) => {
                    this.deps.fileNotice.botOffline("logout", args);
                }),
            );
        }
    }

    /** 退订（幂等）。 */
    unsubscribeAll(): void {
        for (const off of this.unsubscribes) {
            off();
        }
        this.unsubscribes = [];
    }
}
