/**
 * satori/action 测试公共 fixture（test-support.ts）。
 *
 * stubSatoriApi：全 vi.fn 的 SatoriApi 形状桩——各动作只 Pick 自己需要的
 * 子集，测试里 `as unknown as XActionDeps` 注入；默认值给最小合法返回，
 * 用例按需改写（mockResolvedValueOnce / 直接换实现）。
 * mock 返回值断言用 `as never` 收窄（仓库惯例，不放宽被测类型）。
 */
import type {
    CanonicalElement,
    FriendApi,
    GroupApi,
    GroupNotifyApi,
    MsgApi,
    Peer,
    ProfileApi,
} from "@napuketto/kernel";
import { vi } from "vitest";
import { stub } from "../../../core/__tests__/stub.js";

/** uid → uin 默认桩映射（uid_xxx 形式；仅本文件内部使用）。 */
function uinToUidMap(uins: string[]): Map<string, string> {
    return new Map(uins.map((u) => [u, `uid_${u}`] as const));
}

/** 全方法 vi.fn 的 SatoriApi 形状桩（形状对齐 SatoriApiOptions + 便捷方法）。 */
export function stubSatoriApi() {
    return {
        msgApi: stub<MsgApi>({
            sendMessage: vi.fn(async (_target: Peer, _elements: CanonicalElement[]) => ({
                msgId: "sent-msg-1",
            })),
            fetchMsgsByMsgId: vi.fn(async () => [] as never[]),
            fetchMessages: vi.fn(async () => [] as never[]),
            recallMessage: vi.fn(async () => undefined),
            setMsgEmojiLike: vi.fn(async () => undefined),
        }),
        groupApi: stub<GroupApi>({
            getGroupInfo: vi.fn(async () => ({ groupCode: "10001", groupName: "测试群" }) as never),
            getGroupList: vi.fn(async () => [] as never[]),
            getGroupMemberInfo: vi.fn(async () => [] as never[]),
            getGroupMemberList: vi.fn(async () => [] as never[]),
            kickMember: vi.fn(async () => undefined),
            setMemberShutUp: vi.fn(async () => undefined),
            uinToUid: vi.fn(async (uins: string[]) => uinToUidMap(uins)),
            uidToUin: vi.fn(async (uids: string[]) => new Map(uids.map((u) => [u, u] as const))),
        }),
        groupNotifyApi: stub<GroupNotifyApi>({
            getSingleScreenNotifies: vi.fn(async () => [] as never[]),
            handleGroupRequest: vi.fn(async () => undefined),
        }),
        friendApi: stub<FriendApi>({
            getFriendList: vi.fn(async () => [] as never[]),
            deleteFriend: vi.fn(async () => undefined),
            getBuddyReqList: vi.fn(async () => [] as never[]),
            handleFriendRequest: vi.fn(async () => undefined),
        }),
        profileApi: stub<ProfileApi>({
            getStrangerInfo: vi.fn(
                async () => ({ nickname: "陌生人", long_nick: "签名" }) as never,
            ),
        }),
        self: { uin: "10001", nickname: "机器人" },
        selfUin: "10001",
        cacheDir: "/tmp/nk-cache",
        groupCache: undefined as unknown,
        resolvePeer: vi.fn(async () => ({ chatType: 2, peerUid: "10001" }) as never),
        setChannelType: vi.fn((_channelId: string, _isGroup: boolean) => undefined),
        toCanonicalDeps: vi.fn(() => ({
            uinToUid: async (uins: string[]) => uinToUidMap(uins),
            cacheDir: "/tmp/nk-cache",
        })),
        uinToUid: vi.fn(async (uins: string[]) => uinToUidMap(uins)),
        uidToUin: vi.fn(async (uids: string[]) => new Map(uids.map((u) => [u, u] as const))),
    };
}

/** 桩类型（测试内 import type 使用）。 */
export type StubSatoriApi = ReturnType<typeof stubSatoriApi>;
