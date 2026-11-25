/**
 * protocol-types.test-d.ts：协议模块面 / 构造入参的「loader ↔ adapter」类型对拍（2026-11-25）。
 *
 * 背景：`runtime/protocol-types.ts` 的构造入参一度是 `Record<string, unknown>`——adapter
 * 侧重命名一个可选构造项，loader 的 `tsc` 全绿，直到真正启用该协议才在运行期炸。
 * 本文件把「字段名契约」变成编译期断言：loader 侧的结构接口必须仍然是 adapter 公开面
 * 的子集（导出键 / 入参键 / 必填项 / 原始值类型四向），adapter 新增必填项也会在这里红。
 *
 * 为什么取 adapter **源码**类型而非 `dist`：改字段名当场红，不依赖构建顺序与 dts 新鲜度
 * （`dist` 由 `pnpm -r build` 产出，本地 `pnpm check` 前未必是最新的）。
 *
 * 为什么 loader 不直接 import adapter 类型：kernel 的 `MsgApi` / `ConfigBase` 等带
 * `private` 成员，`private` 按声明来源比较，loader 的最小结构镜像永远无法赋值给它们
 * （见 `runtime/protocol-types.ts` 文件头）。
 *
 * ⚠️ 纯类型文件：无运行时断言，由根 `pnpm check`（`tsc --noEmit`）执行；`.test-d.ts`
 * 不匹配 vitest 的 include，不参与单测与覆盖率。
 */

/* ── 断言原语（漂移时错误信息里会点名具体键） ───────────────────────────── */

/** 布尔断言包装：`false` 不等满足约束，tsc 直接报错。 */
type Expect<T extends true> = T;

/** 必填键（`object` 可赋给 `Pick<T, K>` = 该键可选）。 */
type RequiredKeys<T> = {
    [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];

/** loader 侧「多出来」的键 = adapter 已改名 / 删除。 */
type ExtraKeys<Loader, Real> = Exclude<keyof Loader, keyof Real>;

/** adapter 必填但 loader 不传的键 = adapter 新增必填项。 */
type MissingRequired<Loader, Real> = Exclude<RequiredKeys<Real>, keyof Loader>;

/** adapter 必填但 loader 只当可选 = 调用点可漏传（隐式必填项）。 */
type OptionalityDrift<Loader, Real> = Exclude<
    keyof Loader & RequiredKeys<Real>,
    RequiredKeys<Loader>
>;

/** 原始值字段（字符串 / 数字 / 布尔 / undefined）；对象与类实例不作结构化比对。 */
type IsPrimitive<T> = [T] extends [string | number | boolean | undefined] ? true : false;

/** 原始值字段类型不再兼容时落到键名上（其余字段为 never）。 */
type PrimitiveDrift<Loader, Real> = {
    [K in keyof Loader & keyof Real]: IsPrimitive<Real[K]> extends true
        ? [Loader[K]] extends [Real[K]]
            ? never
            : K
        : never;
}[keyof Loader & keyof Real];

/** 导出面 / 实例面：只查「loader 声明的键在真实面上都存在」。 */
type SurfaceCheck<Loader, Real> = [ExtraKeys<Loader, Real>] extends [never]
    ? true
    : { extra: ExtraKeys<Loader, Real> };

/** 构造入参面：键 / 必填项 / 原始值类型三向都要干净。 */
type OptionsCheck<Loader, Real> = [
    ExtraKeys<Loader, Real>,
    MissingRequired<Loader, Real>,
    OptionalityDrift<Loader, Real>,
    PrimitiveDrift<Loader, Real>,
] extends [never, never, never, never]
    ? true
    : {
          extra: ExtraKeys<Loader, Real>;
          missingRequired: MissingRequired<Loader, Real>;
          optionalityDrift: OptionalityDrift<Loader, Real>;
          valueType: PrimitiveDrift<Loader, Real>;
      };

/** 构造器第一个入参（协议适配器的 options）。 */
type FirstCtorArg<T> = T extends abstract new (
    ...args: infer A
) => unknown
    ? A extends [infer First, ...unknown[]]
        ? First
        : never
    : never;

/* ── adapter / network 真实公开面（源码） ──────────────────────────────── */

type AdapterCoreReal = typeof import("../../../../adapter/src/framework/index.ts");
type NetworkReal = typeof import("../../../../network/src/index.ts");
type Ob11Real = typeof import("../../../../adapter/src/onebot11/index.ts");
type SatoriReal = typeof import("../../../../adapter/src/satori/index.ts");
type KurobotReal = typeof import("../../../../adapter/src/kurobot/index.ts");
type MilkyReal = typeof import("../../../../adapter/src/milky/index.ts");

/* ── loader 侧结构接口 ────────────────────────────────────────────────── */

import type {
    AdapterCoreModuleLike,
    KurobotAdapterOptionsLike,
    KurobotModuleLike,
    MilkyAdapterOptionsLike,
    MilkyModuleLike,
    NetworkModuleLike,
    Ob11AdapterLike,
    Ob11AdapterOptionsLike,
    Ob11ModuleLike,
    ProtocolConfigOptionsLike,
    SatoriAdapterOptionsLike,
    SatoriModuleLike,
} from "../../../src/host/runtime/protocol-types.js";

/* ── 对拍断言（任一不成立 = 该协议构造面已漂移，按报错键名修 loader） ──── */

/** adapter/core：ProtocolConfig 导出 + 入参键（path / schema / defaults / seed）。 */
export type AdapterCoreContract = [
    Expect<SurfaceCheck<AdapterCoreModuleLike, AdapterCoreReal>>,
    Expect<
        OptionsCheck<ProtocolConfigOptionsLike, FirstCtorArg<AdapterCoreReal["ProtocolConfig"]>>
    >,
];

/** network：EventBroadcaster 导出 + register/unregister 实例面。 */
export type NetworkContract = [
    Expect<SurfaceCheck<NetworkModuleLike, NetworkReal>>,
    Expect<
        SurfaceCheck<
            InstanceType<NetworkModuleLike["EventBroadcaster"]>,
            InstanceType<NetworkReal["EventBroadcaster"]>
        >
    >,
];

/** OB11：导出面 + 入参面 + 实例面（含动作注册表 names/get）。 */
export type Ob11Contract = [
    Expect<SurfaceCheck<Ob11ModuleLike, Ob11Real>>,
    Expect<
        OptionsCheck<Ob11AdapterOptionsLike, FirstCtorArg<Ob11Real["NapukettoOneBot11Adapter"]>>
    >,
    Expect<SurfaceCheck<Ob11AdapterLike, InstanceType<Ob11Real["NapukettoOneBot11Adapter"]>>>,
    Expect<
        SurfaceCheck<
            Ob11AdapterLike["registry"],
            InstanceType<Ob11Real["NapukettoOneBot11Adapter"]>["registry"]
        >
    >,
];

/** Satori：导出面 + 入参面 + 实例面。 */
export type SatoriContract = [
    Expect<SurfaceCheck<SatoriModuleLike, SatoriReal>>,
    Expect<
        OptionsCheck<SatoriAdapterOptionsLike, FirstCtorArg<SatoriReal["NapukettoSatoriAdapter"]>>
    >,
    Expect<
        SurfaceCheck<
            InstanceType<SatoriModuleLike["NapukettoSatoriAdapter"]>,
            InstanceType<SatoriReal["NapukettoSatoriAdapter"]>
        >
    >,
];

/** Kurobot：导出面 + 入参面 + 实例面。 */
export type KurobotContract = [
    Expect<SurfaceCheck<KurobotModuleLike, KurobotReal>>,
    Expect<
        OptionsCheck<
            KurobotAdapterOptionsLike,
            FirstCtorArg<KurobotReal["NapukettoKurobotAdapter"]>
        >
    >,
    Expect<
        SurfaceCheck<
            InstanceType<KurobotModuleLike["NapukettoKurobotAdapter"]>,
            InstanceType<KurobotReal["NapukettoKurobotAdapter"]>
        >
    >,
];

/** Milky：导出面 + 入参面 + 实例面。 */
export type MilkyContract = [
    Expect<SurfaceCheck<MilkyModuleLike, MilkyReal>>,
    Expect<OptionsCheck<MilkyAdapterOptionsLike, FirstCtorArg<MilkyReal["NapukettoMilkyAdapter"]>>>,
    Expect<
        SurfaceCheck<
            InstanceType<MilkyModuleLike["NapukettoMilkyAdapter"]>,
            InstanceType<MilkyReal["NapukettoMilkyAdapter"]>
        >
    >,
];
