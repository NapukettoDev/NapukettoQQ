# create-napukettoqq

## 0.2.41

### Patch Changes

- fd1daf3: fix(create-napukettoqq): quoteShellArg 按 MSVCRT 规则补全反斜杠转义（紧邻引号的反斜杠串翻倍 + 结尾收口翻倍），修复 CodeQL incomplete-sanitization 高危告警
- @napuketto/cli@0.1.17

## 0.2.40

### Patch Changes

- ff530e1: fix(create-napukettoqq): 适配 `@clack/prompts` 1.8 的类型守卫变更
  
  `@clack/prompts` 1.8.0 起把 `isCancel` 的类型守卫由 `value is symbol` 收窄为
  `value is typeof CANCEL_SYMBOL`（unique symbol），无法再从 `string | symbol` 中
  排除 `symbol`，导致 `tsc --noEmit` 报 `Property 'trim' does not exist on type
  'string | symbol'`。改用运行期 `typeof` 判定取消分支，语义等价且不依赖上游类型
  守卫细节。

## 0.2.39

### Patch Changes

- @napuketto/cli@0.1.16

## 0.2.38

### Patch Changes

- Updated dependencies [c36bac0]
  - @napuketto/cli@0.1.15

## 0.2.37

### Patch Changes

- 98385c2: feat(kernel,adapter): 协议能力补全 B1/B2/B4——

  - 语音主动下载（B1）：MsgApi.downloadPtt 接原生 downloadRichMedia（实测签名：单参数对象 {msgId, elemId, chatType, downloadType, thumbSize}，返回 void，轮询消息元素观察完成），get_record 本地未命中时原生下载，失败回退原始路径+元数据；PttElement 补实测字段（transferStatus/progress/fileUuid 等）
  - friend_add 通知（B2）：kernel 新增 BuddyCache（onBuddyListChange 全量快照维护 + 首帧 baseline 不发事件 + diff 归一化 onBuddyAdded/onBuddyRemoved 事件），adapter 翻译为 OB11 friend_add notice（user_id 取 coreInfo.uin）
  - group_upload 报形式开关（B4）：ob11 配置新增 groupUploadAsNotice（默认 false = message 事件 + file 段透出——修复此前 file 元素被静默丢弃的问题；true = 群文件消息改报 group_upload notice 替代 message 事件），配置模板同步

- Updated dependencies [98385c2]
  - @napuketto/cli@0.1.14

## 0.2.36

### Patch Changes

- Updated dependencies [9b92ca5]
  - @napuketto/cli@0.1.13

## 0.2.35

### Patch Changes

- @napuketto/cli@0.1.12

## 0.2.34

### Patch Changes

- @napuketto/cli@0.1.11

## 0.2.33

### Patch Changes

- @napuketto/cli@0.1.10

## 0.2.32

### Patch Changes

- @napuketto/cli@0.1.9

## 0.2.31

### Patch Changes

- @napuketto/cli@0.1.8

## 0.2.30

### Patch Changes

- @napuketto/cli@0.1.7

## 0.2.29

### Patch Changes

- @napuketto/cli@0.1.6

## 0.2.28

### Patch Changes

- @napuketto/cli@0.1.5

## 0.2.27

### Patch Changes

- @napuketto/cli@0.1.4

## 0.2.26

### Patch Changes

- @napuketto/cli@0.1.3

## 0.2.25

### Patch Changes

- @napuketto/cli@0.1.2

## 0.2.24

### Patch Changes

- b992e0c: fix(create): 修复 `yarn create napukettoqq` 自动 install 时报「The nearest package directory doesn't seem to be part of the project declared in <父目录>」——`yarn install` 在子目录执行时会向上探测父目录的 package.json/yarn.lock，若用户父目录（如 ~）含这些文件，会把生成目录误当作 workspace 子包。`scaffoldProject` 在 pm === "yarn" 时额外写空 yarn.lock 隔离独立项目（yarn 自身报错信息亦建议此做法），install 会重写为真实锁文件，无副作用。同时修复调用方未把 pm 传入 scaffoldProject（默认 pnpm）导致该分支永不触发的问题，并修正 JSDoc「yarn 时额外生成空 yarn.lock」的文档谎言。
  - @napuketto/cli@0.1.1

## 0.2.23

### Patch Changes

- fix(create): 修复 `yarn create napukettoqq` 自动 install 时 corepack 报「tried to access corepack, but it isn't declared in your dependencies」——install 子进程剥离继承的 PnP 加载器条目（NODE_OPTIONS 中的 `--require/--import .../.pnp.cjs|.pnp.loader.mjs`），避免脚手架临时 PnP 上下文拦截 corepack 的 `require("corepack/package.json")`，其余 NODE_OPTIONS 原样保留。

## 0.2.22

### Patch Changes

- 27a37df: fix(cli): 拒绝占位 QQ 号（123456 / 654321），配置模板护栏硬校验——qq 校验收紧为 5-11 位纯数字并拒绝占位值，占位常量单点定义，两处模板占位注释统一措辞
- Updated dependencies [6903386]
- Updated dependencies [27a37df]
  - @napuketto/cli@0.1.0

## 0.2.21

### Patch Changes

- @napuketto/cli@0.0.22

## 0.2.20

### Patch Changes

- 7872faf: fix(create): 生成项目自动采用最新版 @napuketto/cli（自身依赖缺失或泄漏 workspace:\* 时改查 npm registry 最新版兜底），不再交互式选版本；脚手架完成后不再自动启动，改为打开 napuketto.toml 供填写 QQ 号并打印启动指引（cd <项目目录> && yarn/pnpm/npm start）
- Updated dependencies [7872faf]
  - @napuketto/cli@0.0.21

## 0.2.19

### Patch Changes

- @napuketto/cli@0.0.20

## 0.2.18

### Patch Changes

- @napuketto/cli@0.0.19

## 0.2.17

### Patch Changes

- @napuketto/cli@0.0.18

## 0.2.16

### Patch Changes

- @napuketto/cli@0.0.17

## 0.2.15

### Patch Changes

- @napuketto/cli@0.0.16

## 0.2.14

### Patch Changes

- @napuketto/cli@0.0.15

## 0.2.13

### Patch Changes

- @napuketto/cli@0.0.14

## 0.2.12

### Patch Changes

- @napuketto/cli@0.0.13

## 0.2.11

### Patch Changes

- @napuketto/cli@0.0.12

## 0.2.10

### Patch Changes

- @napuketto/cli@0.0.11

## 0.2.9

### Patch Changes

- @napuketto/cli@0.0.10

## 0.2.8

### Patch Changes

- @napuketto/cli@0.0.9

## 0.2.7

### Patch Changes

- @napuketto/cli@0.0.8

## 0.2.6

### Patch Changes

- Updated dependencies [3265791]
  - @napuketto/cli@0.0.7

## 0.2.5

### Patch Changes

- f4db06a: feat(create-napukettoqq): 美化 v4 对齐 koishi create 观感——文件夹名输入改淡灰 placeholder（去 initialValue，直接回车用默认名、键入字符从空自定义）、按调用方包管理器品牌色定向（pnpm 黄 / yarn 蓝 / npm 红，picocolors 16 色近似）、生成后展示项目文件树、去掉「包管理器自动检测」冗余 log

## 0.2.4

### Patch Changes

- @napuketto/cli@0.0.6

## 0.2.3

### Patch Changes

- @napuketto/cli@0.0.5

## 0.2.2

### Patch Changes

- @napuketto/cli@0.0.4

## 0.2.1

### Patch Changes

- 0192e20: 修复 Windows 下自动安装依赖时触发 Node ≥22 的 DEP0190 告警（`shell: true` + args 数组改为拼单命令行字符串，规避 `spawn` 参数不转义的弃用警告）。
- Updated dependencies [69a53e5]
  - @napuketto/cli@0.0.3

## 0.2.0

### Minor Changes

- aed9b67: 脚手架交互层全面升级（@clack/prompts），模板独立化，生成项目精简：

  - 交互换 `@clack/prompts`（create-vue / create-turbo 同款）：intro/outro 边框、
    spinner 进度、log 分级输出、取消处理，替代 prompts+kleur，一站式现代化。
  - 模板独立化为 `templates/` 目录（随 npm 包发布，`files` 含 `templates/`），
    不再硬编码在源码；占位符 `{{packageName}}` / `{{cliVersion}}` / `{{dataDir}}`
    渲染，未提供的占位符抛错防漏插值。
  - 生成项目精简为 `package.json` + `napuketto.toml` 两个文件：用户项目是
    「运行壳」，生成后不写代码、不开仓库，readme / .gitignore 是死文件，已移除。
  - 新增参数：`-f/--forced`（目标目录非空时强制清空覆盖）、`-y/--yes`（全默认
    跳过交互）、`-h/--help`（帮助）。
  - 模板文件统一 `.tmpl` 后缀（`templates/*.tmpl`）：避免 VS Code 的 TOML/JSON
    语言服务把 `{{dataDir}}` 等占位符当非法语法报 `expected identifier`；
    `scaffold.ts` 写盘时去掉 `.tmpl` 后缀。
  - 删除冗余的根目录 `napuketto.toml.example`（有 `config init` 与脚手架生成
    配置，示例文件三处重复维护无人阅读），同步清理 `config-cmds.ts` / `readme.md`
    引用。
  - 修复 `templates/napuketto.toml` 被根 `.gitignore` 的 `napuketto.toml` 规则
    误伤忽略（git 不跟踪则 clone 后脚手架无法生成配置）：模板改 `.tmpl` 后缀后
    不再匹配该规则，例外规则收敛为 `!apps/create-napukettoqq/templates/*.tmpl`。

### Patch Changes

- Updated dependencies [d590ab5]
  - @napuketto/cli@0.0.2
