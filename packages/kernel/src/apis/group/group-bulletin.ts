/**
 * 群公告（announcements）子域：getGroupBulletin / publishGroupBulletin /
 * deleteGroupBulletin / uploadGroupBulletinPic 的参数形状均待探测校准。
 */
import { errorMessage, isKernelError, isRecord, kernelError } from "../../infra/index.js";
import type { GroupBulletin, NodeIKernelGroupService } from "../../types/index.js";
import { checkLooseResult, unwrap } from "../result.js";
import { extractBulletins, toOptionalString, toResultNumber } from "./group-parsers.js";

/**
 * 群公告列表（get_group_announcements；getGroupBulletin 返回形状待探测校准，
 * 兼容 result 数组 / result.bulletins 等宽松提取）。
 */
export async function getGroupAnnouncements(
    service: NodeIKernelGroupService,
    groupCode: string,
): Promise<GroupBulletin[]> {
    let raw: unknown;
    try {
        raw = await service.getGroupBulletin(groupCode);
    } catch (e) {
        if (isKernelError(e)) {
            throw e;
        }
        throw kernelError(`getGroupBulletin 调用失败: ${errorMessage(e)}`, "UNKNOWN");
    }
    const result = isRecord(raw) ? raw["result"] : undefined;
    const errMsg = isRecord(raw) ? toOptionalString(raw["errMsg"]) : undefined;
    unwrap("getGroupBulletin", toResultNumber(result), errMsg);
    return extractBulletins(result);
}

/**
 * 发群公告（send_group_announcement；imagePath 提供时先 uploadGroupBulletinPic
 * 再带 picId 发布——两步参数形状均待探测校准）。
 */
export async function publishGroupAnnouncement(
    service: NodeIKernelGroupService,
    groupCode: string,
    content: string,
    imagePath?: string,
): Promise<void> {
    let picId: string | undefined;
    if (imagePath !== undefined && imagePath !== "") {
        picId = await uploadBulletinPic(service, groupCode, imagePath);
    }
    try {
        checkLooseResult(
            "publishGroupBulletin",
            await service.publishGroupBulletin({
                groupCode,
                content,
                ...(picId !== undefined ? { picId } : {}),
            }),
        );
    } catch (e) {
        if (isKernelError(e)) {
            throw e;
        }
        throw kernelError(`publishGroupBulletin 调用失败: ${errorMessage(e)}`, "UNKNOWN");
    }
}

/** 删群公告（delete_group_announcement；参数待探测校准）。 */
export async function deleteGroupAnnouncement(
    service: NodeIKernelGroupService,
    groupCode: string,
    announcementId: string,
): Promise<void> {
    try {
        checkLooseResult(
            "deleteGroupBulletin",
            await service.deleteGroupBulletin(groupCode, announcementId),
        );
    } catch (e) {
        if (isKernelError(e)) {
            throw e;
        }
        throw kernelError(`deleteGroupBulletin 调用失败: ${errorMessage(e)}`, "UNKNOWN");
    }
}

/** 公告图片上传（uploadGroupBulletinPic 返回 picId 待校准，失败原样上抛）。 */
async function uploadBulletinPic(
    service: NodeIKernelGroupService,
    groupCode: string,
    imagePath: string,
): Promise<string> {
    const res = await service.uploadGroupBulletinPic(groupCode, imagePath);
    checkLooseResult("uploadGroupBulletinPic", res);
    return isRecord(res) && typeof res["picId"] === "string" ? res["picId"] : "";
}
