/**
 * codec 域公共出口：canonical 消息元素 ↔ NT 元素双向转换。
 *
 * 独立于 `types/`（纯类型声明）与 `apis/`（业务语义封装）的运行时转换层，
 * 只依赖 `infra/` 与 `types/` 叶子模块，供 apis / bridge 同层复用。
 */
export { picLocalCandidates, toCanonicalElements, toSendElements } from "./message-element.js";
