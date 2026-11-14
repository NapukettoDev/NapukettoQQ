/**
 * upload_group_file / upload_private_file（闪传通道）动作测试：
 *  - 成功路径：peer 映射（群号直通 / uin→uid）、paths/name 透传、file_id = fileSetId
 *  - name 缺省 → 路径末段；folder schema 兼容但忽略
 *  - 远程 URI → 105（仅本地路径 / file://）
 *  - 闪传抛错 → 动作失败（不静默假成功）
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlashTransferUploadOptions, Peer } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { createSystemFileActions } from "../system/file.js";
import { ob11ActionOf, stubConverters } from "./test-support.js";

function makeDeps(
    sendFile = vi.fn(
        async (_target: Peer, _paths: string[], _options: FlashTransferUploadOptions) => ({
            fileSetId: "fs-1",
            shareLink: "",
            fileCount: 1,
        }),
    ),
) {
    const { uinToUid } = stubConverters();
    // 局部桩缺 OneBotApi 其余成员，整体 as never（与其他域测试桩约定一致）
    return { deps: { flashTransferApi: { sendFile } as never, uinToUid } as never, sendFile };
}

describe("upload_group_file（闪传）", () => {
    it("群号直通作为 destUid，file:// 展开后传路径，file_id = fileSetId", async () => {
        const { deps, sendFile } = makeDeps();
        const res = await ob11ActionOf(createSystemFileActions(deps), "upload_group_file").handle({
            group_id: 10001,
            file: pathToFileURL(join("tmp", "up.bin")).href,
            name: "up.bin",
        });
        expect(res.status).toBe("ok");
        expect(res.data).toEqual({ file_id: "fs-1" });
        const [peer, paths, opts] = sendFile.mock.calls[0] ?? [];
        expect(peer).toEqual({ chatType: 2, peerUid: "10001" });
        // pathToFileURL 把相对路径解析为绝对路径：断言 file:// 已剥离
        expect(paths?.[0]?.endsWith(join("tmp", "up.bin"))).toBe(true);
        expect(opts?.name).toBe("up.bin");
    });

    it("name 缺省 → 取路径末段；folder 忽略（闪传无目录）", async () => {
        const { deps, sendFile } = makeDeps();
        const res = await ob11ActionOf(createSystemFileActions(deps), "upload_group_file").handle({
            group_id: 10001,
            file: "/data/report.pdf",
            folder: "/docs",
        });
        expect(res.status).toBe("ok");
        const [, paths, opts] = sendFile.mock.calls[0] ?? [];
        expect(paths).toEqual(["/data/report.pdf"]);
        expect(opts?.name).toBe("report.pdf");
    });

    it("远程 URI → -400（仅本地路径 / file://）", async () => {
        const { deps, sendFile } = makeDeps();
        const res = await ob11ActionOf(createSystemFileActions(deps), "upload_group_file").handle({
            group_id: 10001,
            file: "https://example.com/a.zip",
        });
        expect(res.retcode).toBe(105);
        expect(res.message).toContain("只支持本地路径");
        expect(sendFile).not.toHaveBeenCalled();
    });

    it("base64:// → 105", async () => {
        const { deps } = makeDeps();
        const res = await ob11ActionOf(createSystemFileActions(deps), "upload_group_file").handle({
            group_id: 10001,
            file: "base64://QUJD",
        });
        expect(res.retcode).toBe(105);
    });

    it("闪传抛错 → 动作失败（错误透传）", async () => {
        const sendFile = vi.fn(async () => {
            throw new Error("闪传上传超时（10000ms，已完成 0/1）");
        });
        const { deps } = makeDeps(sendFile);
        const res = await ob11ActionOf(createSystemFileActions(deps), "upload_group_file").handle({
            group_id: 10001,
            file: "/data/a.bin",
        });
        expect(res.status).not.toBe("ok");
    });
});

describe("upload_private_file（闪传）", () => {
    it("user_id 经 uin→uid 转成 destUid，file_id = fileSetId", async () => {
        const { deps, sendFile } = makeDeps();
        const res = await ob11ActionOf(createSystemFileActions(deps), "upload_private_file").handle(
            {
                user_id: 90001,
                file: "/data/a.zip",
                name: "a.zip",
            },
        );
        expect(res.status).toBe("ok");
        expect(res.data).toEqual({ file_id: "fs-1" });
        const [peer, paths, opts] = sendFile.mock.calls[0] ?? [];
        expect(peer).toEqual({ chatType: 1, peerUid: "u90001" });
        expect(paths).toEqual(["/data/a.zip"]);
        expect(opts?.name).toBe("a.zip");
    });

    it("uid 解析失败 → 105（不猜目标）", async () => {
        const { deps, sendFile } = makeDeps();
        const res = await ob11ActionOf(createSystemFileActions(deps), "upload_private_file").handle(
            {
                user_id: 123456,
                file: "/data/a.zip",
            },
        );
        expect(res.retcode).toBe(105);
        expect(sendFile).not.toHaveBeenCalled();
    });
});
