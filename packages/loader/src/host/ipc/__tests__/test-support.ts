/**
 * IPC 测试公共 fixture（test-support）：mock kernel apis 上下文。
 *
 * 供 ipc-actions-diag 等测试复用，避免同构 setup 跨文件复制；
 * stdout 捕获等按文件内联（各测试对捕获粒度需求不同，强行共用反而增加耦合）。
 */
import { vi } from "vitest";
import type { IpcApiContext } from "../ipc-actions.js";

/** mock kernel apis 上下文（每次调用返回全新 vi.fn，互不串扰）。 */
export function mockIpcCtx(): IpcApiContext {
    return {
        msgApi: {
            sendMessage: vi.fn(async () => ({ msgId: "42" })),
            recallMessage: vi.fn(async () => undefined),
            fetchMessages: vi.fn(async () => [{ msgId: "1" }]),
            markRead: vi.fn(async () => undefined),
        },
        groupApi: {
            getGroupList: vi.fn(async () => []),
        },
        groupCache: {
            listGroupsRefreshed: vi.fn(async () => [{ groupCode: "10001", groupName: "测试群" }]),
        },
        friendApi: {
            getFriendList: vi.fn(async () => [{ uid: "u1" }]),
        },
        self: { uin: "10001", nickname: "测试号" },
        uinToUid: vi.fn(async (uins: string[]) => {
            const map = new Map<string, string>();
            for (const uin of uins) {
                map.set(uin, `u_${uin}`);
            }
            return map;
        }),
    };
}
