# create-napukettoqq 脚手架设计

> 职责：npm 脚手架 `create-napukettoqq`，生成用户项目骨架（`package.json` + `napuketto.toml`）并按
> 调用方包管理器装依赖；不管运行时（业务与协议装配在 `@napuketto/cli`），生成后由 cli → loader
> 自建宿主启动。源码入口 `src/index.ts`（参数/交互）与 `src/scaffold.ts`（模板/目录/包管理器检测）。

## 核心机制

### 包名与调用方式

- `yarn create napukettoqq` / `pnpm create napukettoqq` / `npm create napukettoqq`：包管理器从
  registry 拉 `create-napukettoqq` 并执行同名 bin（`dist/index.mjs`），所以包名必须带 `create-` 前缀。
- 生成物是**独立用户项目**（非 monorepo 包）：`package.json` 只声明 `@napuketto/cli` 依赖，
  install 后 `start` 经 cli → loader 自建宿主（标准 node + stub QQNT.dll）。
- QQ 资源（`wrapper.node`）由 loader 在启动时定位：本机 QQ NT 安装 / 数据根缓存 / 自动下载；
  脚手架不下载、不打包 QQ 二进制（腾讯版权）。

### 模板随包发布与生成

- 模板是包内独立文件 `templates/`：`package.json` 的 `files` 含 `templates`，随 npm 包发布；
  运行时按 `new URL("../templates/", import.meta.url)` 定位（src 与 dist 同级，均指向包根）。
- 模板后缀统一 `.tmpl`（`package.json.tmpl`、`napuketto.toml.tmpl`）：避免编辑器 JSON/TOML 语言服务
  把 `{{...}}` 当非法语法；`scaffold.ts` 的 `files` 数组显式映射模板名 → 输出名（去掉 `.tmpl`）。
- `renderTemplate` 替换 `{{key}}`，未提供的占位符直接抛错（防写出半成品）。变量只有两个：
  `{{packageName}}`（文件夹名小写、空格 → `-`）、`{{cliVersion}}`（见「跨包契约」）。
  `napuketto.toml` 不插值 `dataDir`：缺省 `<项目根>/.napuketto`，跨平台。
- 模板内容与 `apps/cli/src/config/template.ts` 的 `configTemplate()` 保持一致（双维护，极少变更）。

### CLI 参数与交互流

```bash
create-napukettoqq                # 交互问部署文件夹名（默认 NapukettoQQ）
create-napukettoqq my-bot         # 位置参数指定文件夹名，跳过命名交互
create-napukettoqq my-bot -f      # 目标目录非空时强制清空覆盖
create-napukettoqq -y             # 全默认：命名用默认值（不隐式清空已有目录）
create-napukettoqq -h             # 打印 usage 退出
```

- 参数手写解析（flag 仅三个，不引 yargs-parser）：未知 flag / 多余位置参数抛错，退出码 1。
- 交互层 `@clack/prompts`：`intro`（品牌色标题 + 自身版本号）、`text`（文件夹名，placeholder 为
  淡灰默认名，回车即默认、键入即自定义，空输入不报错）、`confirm`（是否清空，
  `initialValue: false`）、`spinner`（生成骨架）、`log.info/warn/error/success/step/message`、
  `outro`、`cancel`。
- 校验 `validateProjectName`：非空、非 `.`/`..`、不含 `\/:*?"<>|`。命名交互返回非字符串
  （Ctrl+C / 取消）→ `cancel` + 退出码 0；源码没有非 TTY 默认值兜底，CI 请用 `-y` 或位置参数。

### 包管理器自动检测

- 检测源 `npm_config_user_agent`（三种 create 都会注入）：`yarn/…` → yarn、`npm/…` → npm，
  其余（含空值、直接 `node dist/index.mjs`）→ pnpm 兜底。
- 生成项目与包管理器无关（只有依赖 + scripts），差异只在 install/start 命令与品牌色：
  pnpm 黄 / yarn 蓝 / npm 红（`node:util` `styleText`，非 TTY 或 `NO_COLOR` 退化为纯文本）。
- Windows 下 bin 带 `.cmd`（`pmBin`；CreateProcess 不认无扩展名 shim）；`runInteractive` 在 win32
  走 `shell: true` 经 cmd.exe 并按 MSVCRT 规则转义参数，POSIX 直接 bin + args。
- **yarn dlx 的 PnP 注入**：`yarn create` 实为 `yarn dlx`，脚手架跑在临时 PnP 项目里，PnP 钩子经
  `NODE_OPTIONS` 注入并会被 install 子进程继承，corepack 解析 yarn 版本时
  `require("corepack/package.json")` 被 PnP 拦截报错。`subprocessEnv()` 只剥掉 NODE_OPTIONS 里的
  PnP 加载器条目（`--require/--import … .pnp.cjs/.pnp.loader.mjs`），其余原样；pnpm/npm 无该条目，
  等价透传，生成项目与脚手架的 PnP 上下文无关。
- **yarn 向上探测父目录 workspace**：`yarn install` 会向上找父目录的 `package.json`/`yarn.lock`，
  父目录（典型如 `~`）存在这些文件时会把生成目录误当 workspace 子包并报
  「nearest package directory … doesn't seem to be part of the project」。故 `scaffoldProject` 在
  `pm === "yarn"` 时额外写一个**空 `yarn.lock`**，让生成目录成为独立项目根；install 随后会把它重写
  为真实锁文件，无运行时副作用。pnpm/npm 无此探测，不写。

### 生成骨架

```text
<目标目录>/
├── package.json      # name=派生名；scripts.start="napuketto"；dependencies: @napuketto/cli
├── napuketto.toml    # 与 cli configTemplate 同款；账号段留占位 qq + 注释
└── yarn.lock         # 仅 yarn：空文件，隔离父目录 workspace
```

- 默认两个文件（yarn 三个）。用户项目是「运行壳」：生成后不写代码、不 `git init`，因此不生成
  `readme` / `.gitignore`（无人读、不 init 即死文件）。
- 目标目录：不存在 / 为空 → 直接生成；已存在且非空 → `log.warn` + `confirm`（`-f` 跳过确认；
  `-y` 不隐式清空，仍需确认或显式 `-f`）；清空只删目录内容、保留目录本身；取消 → outro + 退出码 0。
- 写入前 `mkdir -p`；模板渲染完再逐文件写盘，全部在 `spinner` 期间完成。

### 启动序列

```text
parseArgs → detectPackageManager → intro
  → 问文件夹名（位置参数 / -y 跳过）→ validateProjectName → 目标目录准备
  → spinner: scaffoldProject（渲染模板 + 写文件）→ 打印文件树
  → <pm> install（stdio 继承，用户可见进度）
      └ 失败 → log.error + `cd <dir> && <pm> install` 指引 + 退出码 1
  → 打开 napuketto.toml（系统默认编辑器）+ 打印启动指引 `cd <dir> && <pm> start`
  → outro
```

- **不自动启动**：占位账号（`qq = "123456"`）启动无意义，且自动前台运行占用终端；改为打开配置
  文件供填 QQ 号 + 打印指引，由用户自行 `start`。
- 打开文件尽力而为：Windows 走 `cmd.exe /c start "" "<file>"`，macOS `open`，其他 `xdg-open`；
  `detached + unref`，失败不阻塞流程（提示照常打印）。

## 跨包契约

- 对 `@napuketto/cli` 只声明依赖范围，不在运行时依赖它：cli 放 `devDependencies`（`workspace:*`），
  脚手架不 import cli，install 时不会先拉 cli→adapter→network→media→kernel 整棵生产依赖树。
- `cliVersionRange()` 运行时自读脚手架自身 `package.json`：先 `devDependencies["@napuketto/cli"]`、
  再 `dependencies`，非 `workspace:*` 即原样使用；否则查 registry `@napuketto/cli/latest`
  （3s 超时）拼 `^<version>`；仍失败兜底 `^0.0.1`。发版由 changesets 升版本、发布链改写
  `workspace:*` 为实际版本，范围自动跟随，**源码里没有需要手动同步的版本常量**。
- 生成项目的对外形态由 `templates/package.json.tmpl` 固定：`private: true`、`type: module`、
  `scripts.start = "napuketto"`（经 `node_modules/.bin`）、依赖只有 `@napuketto/cli`。
- 错误传播：脚手架自身异常 → `log.error` + 退出码 1；install 非 0 → 手动指引 + 退出码 1；
  用户取消 → 退出码 0，且确认前不清空任何文件。
- 启动链路见 [`docs/architecture/runtime.md`](../../../docs/architecture/runtime.md)；
  配置模板来源见 [`apps/cli/src/config/template.ts`](../../cli/src/config/template.ts)。

## 关键取舍与不变量

- **不默认 pnpm**：install/start 跟随调用方包管理器；写死 pnpm 会把 yarn/npm 用户带进不匹配的
  命令链，属缺陷而非简化。
- **模板与 cli 模板同步**：`templates/napuketto.toml.tmpl` 与 `configTemplate()` 是两份事实，
  改默认值或注释必须两边同时改；cli 启动时发现配置已存在不会覆盖，生成物即用户长期配置。
- **版本锁定**：生成项目固定 `^<当前 cli 范围>`，不交互选版本、不追 latest 漂移；脚手架自身不
  import cli，只从自身 `package.json` 读范围。
- **功能边界**：只做「生成可运行壳 + 引导填配置」——不下载 QQ 资源、不装配协议、不自动启动、
  不生成 readme/.gitignore；新增能力落在 cli，不落在脚手架。
- **模板发布白名单**：新增模板必须同时改 `scaffold.ts` 的 `files` 数组与 `package.json` 的
  `files`，否则发布产物缺文件（本地 workspace 直跑测不出来）。
