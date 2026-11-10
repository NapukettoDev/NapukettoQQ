/**
 * dlopen-check.cjs：在 stub + gnutls 预加载下真 dlopen Linux `wrapper.node`，
 * 断言导出面（smoke.mjs 的子进程；CJS 便于直接 `node` 跑，且不 import 任何包）。
 *
 * 用法：LD_PRELOAD=<stub>:<libgnutls.so.30> node dlopen-check.cjs <wrapper.node> [minExports]
 */
const wrapperPath = process.argv[2];
const minExports = Number(process.argv[3] ?? "100");

if (wrapperPath === undefined) {
    console.error("[smoke] 用法: node dlopen-check.cjs <wrapper.node> [minExports]");
    process.exit(2);
}

const mod = { exports: {} };
try {
    process.dlopen(mod, wrapperPath);
} catch (error) {
    console.error(`[smoke] dlopen 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
}

const keys = Object.keys(mod.exports);
const hasEngine = keys.includes("NodeIQQNTWrapperEngine");
console.log(`[smoke] exports=${keys.length} engine=${String(hasEngine)}`);

if (keys.length < minExports) {
    console.error(`[smoke] 导出面过小：${keys.length} < ${minExports}`);
    process.exit(4);
}
if (!hasEngine) {
    console.error("[smoke] 缺少 NodeIQQNTWrapperEngine（导出面异常）");
    process.exit(5);
}

// ⚠️ 必须显式退出：wrapper 的 dlopen 会在进程内起原生线程（Bugly / 事件循环），
// 断言通过后 Node 事件循环仍不空，进程会一直挂着（本地实测 45s 被 timeout 杀掉）。
process.exit(0);
