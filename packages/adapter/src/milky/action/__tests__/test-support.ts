/**
 * Milky 动作层测试公共依赖桩（p3-* 系列共用，避免同构 setup 跨文件复制）
 *
 * - `buildMilkyApi`：kernel apis 全量桩（uin↔uid 固定映射 uid-N ↔ "N"），
 *   各动作测试只覆写关心的方法（overrides 按服务浅合并）。
 * - `actionOf`：按名取动作，未注册即抛错（测试装配失败的快速失败）。
 * - `memberStub` / `friendStub` / `detailStub`：kernel 实体最小形状。
 */
import type { Friend, GroupDetailInfo, GroupMember } from "@napuketto/kernel";
import { ChatType } from "@napuketto/kernel";
import { vi } from "vitest";
import type { ActionRegistry } from "../../../core/index.js";
import { MilkyApi } from "../../api.js";
import { MessageSeqIndex } from "../../helper/state/seq-index.js";
import type { MilkyAction } from "../base-action.js";
import { createMilkyActionRegistry } from "../index.js";

/** 服务方法覆写表（键名与 MilkyApiOptions 一致；值并入对应服务桩）。 */
export interface ApiOverrides {
    msgApi?: Record<string, unknown>;
    groupApi?: Record<string, unknown>;
    friendApi?: Record<string, unknown>;
    profileApi?: Record<string, unknown>;
    profileLikeApi?: Record<string, unknown>;
    ticketApi?: Record<string, unknown>;
    webApi?: Record<string, unknown>;
    groupNotifyApi?: Record<string, unknown>;
    richMediaApi?: Record<string, unknown>;
    flashTransferApi?: Record<string, unknown>;
    recentContactApi?: Record<string, unknown>;
    /** self.uid（nudge / friend_requests.target_user_uid 用；空串 = 缺失场景）。 */
    selfUid?: string;
    selfUin?: string;
    groupCache?: Record<string, unknown>;
    mediaDir?: string;
    logger?: unknown;
}

/** 群成员最小形状（uin/card 可覆写）。 */
export function memberStub(overrides: Partial<GroupMember> = {}): GroupMember {
    return {
        uid: "uid-20002",
        uin: "20002",
        nick: "甲",
        cardName: "",
        remark: "",
        role: 2,
        shutUpTime: 0,
        joinTime: "1760000000",
        lastSpeakTime: "1760000100",
        ...overrides,
    };
}

/** 好友最小形状。 */
export function friendStub(overrides: Partial<Friend> = {}): Friend {
    return {
        uid: "uid-20002",
        uin: "20002",
        nickname: "甲",
        remark: "备注甲",
        ...overrides,
    };
}

/** 群详情最小形状。 */
export function detailStub(overrides: Partial<GroupDetailInfo> = {}): GroupDetailInfo {
    return {
        groupCode: "10001",
        groupUin: "10001",
        ownerUin: "20002",
        groupName: "测试群",
        memberNum: 3,
        maxMemberNum: 500,
        remarkName: "群备注",
        groupCreateTime: 1760000000,
        ...overrides,
    };
}

/** 构造全量桩 MilkyApi（uid-N ↔ "N" 固定映射；overrides 浅合并各服务）。 */
export function buildMilkyApi(overrides: ApiOverrides = {}): MilkyApi {
    const opts = {
        msgApi: { ...overrides.msgApi },
        groupApi: {
            uinToUid: vi.fn(async (uins: string[]) => new Map(uins.map((u) => [u, `uid-${u}`]))),
            uidToUin: vi.fn(
                async (uids: string[]) => new Map(uids.map((u) => [u, u.replace("uid-", "")])),
            ),
            ...overrides.groupApi,
        },
        friendApi: {
            getBuddyReqList: vi.fn(async () => []),
            getFriendList: vi.fn(async () => [] as Friend[]),
            ...overrides.friendApi,
        },
        profileApi: { ...overrides.profileApi },
        profileLikeApi: { ...overrides.profileLikeApi },
        ticketApi: { ...overrides.ticketApi },
        webApi: { ...overrides.webApi },
        groupNotifyApi: {
            getSingleScreenNotifies: vi.fn(async () => []),
            handleGroupRequest: vi.fn(async () => undefined),
            ...overrides.groupNotifyApi,
        },
        richMediaApi: { ...overrides.richMediaApi },
        flashTransferApi: {
            sendFile: vi.fn(async () => ({ fileSetId: "fs-stub", shareLink: "", fileCount: 1 })),
            ...overrides.flashTransferApi,
        },
        recentContactApi: {
            getPinnedContacts: vi.fn(async () => []),
            ...overrides.recentContactApi,
        },
        self: {
            uin: overrides.selfUin ?? "10000",
            nickname: "机器人",
            uid: overrides.selfUid ?? "uid-10000",
        },
        qqVersion: "9.9.9-test",
        implVersion: "0.0.0",
        ...(overrides.groupCache !== undefined ? { groupCache: overrides.groupCache } : {}),
        ...(overrides.mediaDir !== undefined ? { mediaDir: overrides.mediaDir } : {}),
        ...(overrides.logger !== undefined ? { logger: overrides.logger } : {}),
    } as unknown as ConstructorParameters<typeof MilkyApi>[0];
    return new MilkyApi(opts, new MessageSeqIndex());
}

/** 构造动作注册表（共享桩 API）。 */
export function registryOf(api: MilkyApi): ActionRegistry<MilkyAction<unknown, unknown>> {
    return createMilkyActionRegistry({ api });
}

/** 按名取动作（未注册抛错：用例自身装配错误的快速失败）。 */
export function actionOf(
    registry: ActionRegistry<MilkyAction<unknown, unknown>>,
    name: string,
): MilkyAction<unknown, unknown> {
    const act = registry.get(name);
    if (act === undefined) {
        throw new Error(`动作未注册: ${name}`);
    }
    return act;
}

/**
 * 群类依赖桩（groupApi 全方法 vi.fn；group 四域测试共用，2026-11-14 自 p3-group
 * 上移）。groupApi/msgApi/webApi/groupNotifyApi 缺省桩可覆写，其余服务键
 * （friendApi / richMediaApi / flashTransferApi / recentContactApi / groupCache /
 * selfUid 等）经 spread 直通 buildMilkyApi。
 */
export function groupRegistry(overrides: ApiOverrides = {}): ReturnType<typeof registryOf> {
    return registryOf(
        buildMilkyApi({
            ...overrides,
            groupApi: {
                modifyGroupName: vi.fn(async () => undefined),
                setMemberCardName: vi.fn(async () => undefined),
                setMemberRole: vi.fn(async () => undefined),
                setMemberShutUp: vi.fn(async () => undefined),
                setGroupShutUp: vi.fn(async () => undefined),
                kickMember: vi.fn(async () => undefined),
                quitGroup: vi.fn(async () => undefined),
                getGroupInfo: vi.fn(async () => detailStub()),
                getGroupMemberList: vi.fn(async () => [memberStub()]),
                removeGroupEssence: vi.fn(async () => undefined),
                addGroupEssence: vi.fn(async () => undefined),
                getGroupAnnouncements: vi.fn(async () => []),
                publishGroupAnnouncement: vi.fn(async () => undefined),
                deleteGroupAnnouncement: vi.fn(async () => undefined),
                setGroupAvatar: vi.fn(async () => undefined),
                setMemberSpecialTitle: vi.fn(async () => undefined),
                ...overrides.groupApi,
            },
            msgApi: {
                setMsgEmojiLike: vi.fn(async () => undefined),
                sendNudge: vi.fn(async () => null),
                fetchMessages: vi.fn(async () => []),
                ...overrides.msgApi,
            },
            webApi: {
                getEssenceMsgList: vi.fn(async () => []),
                ...overrides.webApi,
            },
            groupNotifyApi: {
                getSingleScreenNotifies: vi.fn(async () => []),
                handleGroupRequest: vi.fn(async () => undefined),
                ...overrides.groupNotifyApi,
            },
        }),
    );
}

/**
 * 消息类依赖桩（msgApi 常用方法 vi.fn；message 三域测试共用，2026-11-14 自
 * p3-message 上移）。msgApi 缺省桩可覆写，其余服务键经 spread 直通。
 */
export function messageApi(overrides: ApiOverrides = {}): ReturnType<typeof registryOf> {
    return registryOf(
        buildMilkyApi({
            ...overrides,
            msgApi: {
                sendMessage: vi.fn(async () => ({ msgId: "sent-1" })),
                fetchMsgsByMsgId: vi.fn(async () => []),
                fetchMessages: vi.fn(async () => []),
                recallMessage: vi.fn(async () => undefined),
                markRead: vi.fn(async () => undefined),
                queryFavEmojis: vi.fn(async () => ["https://face.example/1.png"]),
                ...overrides.msgApi,
            },
        }),
    );
}

/** 可索引的原始消息（群聊文本；msgSeq/msgId 可覆写，seq 索引登记用）。 */
export function indexableMsg(seq: string, msgId = "m-idx") {
    return {
        msgId,
        msgSeq: seq,
        msgTime: "1760000000000",
        msgType: 0,
        chatType: ChatType.GROUP,
        peerUid: "10001",
        peerUin: "10001",
        senderUid: "uid-20002",
        senderUin: "20002",
        peerName: "测试群",
        sendNickName: "甲",
        elements: [{ elementType: 1, textElement: { content: "hi" } }],
    };
}
