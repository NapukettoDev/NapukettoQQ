/**
 * QQ 安装目录探测的纯类型契约（从 locate-qq.ts 下沉）
 *
 * 供 locate-qq / qq-extract / boot / apps 层共享，避免 `qq-extract -> locate-qq`
 * 的环形值依赖（本文件零运行时导入）。
 */

/** QQ 文件来源。 */
export type QqFileSource = "local" | "cached";

/** QQ 安装目录探测结果。 */
export interface QqInstallInfo {
    /** QQ.exe 绝对路径（cached 来源为语义占位——缓存目录无 QQ.exe，当前无消费方）。 */
    qqPath: string;
    /** 安装根目录 / 文件根目录。 */
    installDir: string;
    /** 当前版本目录名（如 9.9.31-49919）。 */
    version: string;
    /** wrapper.node 绝对路径。 */
    wrapperPath: string;
    /** 来源：local = 本机安装；cached = NAPUTO_QQ_FILES / 数据根缓存。 */
    source: QqFileSource;
}

/** resolveQqFiles 选项。 */
export interface ResolveQqFilesOptions {
    /** 显式文件根（L0；缺省读 NAPUTO_QQ_FILES）。 */
    qqFilesDir?: string;
    /** 显式 QQ.exe 路径（L1；缺省读 NAPUTO_QQ_PATH）。 */
    qqPath?: string;
    /** 数据根（L2 缓存扫描；缺省轻量解析 NAPKETTO_DATA ?? 项目根/.napuketto）。 */
    dataRoot?: string;
    /** L0/L1/L2 全部失败时自动进入下载流程（P1；默认 true，测试可关）。 */
    autoDownload?: boolean;
    /** 7z 可执行文件路径（解包用；缺省自动探测）。 */
    sevenZipPath?: string;
    /**
     * 阶段回调（下载/校验/解包/提取各阶段提示，2026-08-23 WSL 事故后加：
     * 下载 313MB 全程静默，用户以为流程没生效）。调用方接 logger.info。
     */
    onStage?: (message: string) => void;
}
