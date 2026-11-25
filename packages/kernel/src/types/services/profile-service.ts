/**
 * NodeIKernelProfileService：资料服务接口面（自研描述，非移植）。
 * 依据运行时反射 + wrapper 外部契约（接口签名是 QQ 的外部事实，自研描述其形状，零复制）；
 * 只收录 apis/profile 需要的方法，其余按需探测后补齐。
 */
import type { GeneralCallResult } from "./msg-service.js";

/** 用户详情（getUserDetailInfoByUin / getUserDetailInfo 返回，宽松自研描述，待探测校准）。 */
export interface UserDetailInfoByUin {
    detail?: {
        uid?: string;
        uin?: string;
        simpleInfo?: {
            coreInfo?: { nick?: string; remark?: string };
            baseInfo?: { age?: number; qid?: string; sex?: number; longNick?: string };
            vasInfo?: { svipFlag?: boolean; yearVipFlag?: boolean; vipLevel?: number };
            status?: { status?: number };
            relationFlags?: Record<string, unknown>;
        };
        commonExt?: { qqLevel?: number; regTime?: number };
    };
    [key: string]: unknown;
}

/** 资料服务。 */
export interface NodeIKernelProfileService {
    addKernelProfileListener(listener: unknown): number;
    removeKernelProfileListener(listenerId: number): void;
    /** 设置个性签名（set_self_longnick）。 */
    setLongNick(longNick: string): Promise<unknown>;
    /** 设置昵称（set_qq_profile）。 */
    setNickName(nickName: string): Promise<unknown>;
    /** 设置头像（set_qq_avatar）。 */
    setHeader(filePath: string): Promise<GeneralCallResult>;
    /** 按 uin 获取用户详情（get_stranger_info 第一步）。 */
    getUserDetailInfoByUin(uin: string): Promise<UserDetailInfoByUin>;
    /** 按 uid 获取用户详情（get_stranger_info 第二步，noCache=true 强制刷新）。 */
    getUserDetailInfo(uid: string): Promise<UserDetailInfoByUin>;
    isNull(): boolean;
}
