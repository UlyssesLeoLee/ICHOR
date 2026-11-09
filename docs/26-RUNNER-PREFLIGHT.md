# ATS-DD-026 Playwright CLI 运行前预检与参数安全基线（ATS-106）

本文定义 Bridge 在**启动一次 Playwright 运行之前**做的两件事：

1. **环境预检**：项目本地的 Playwright CLI 是否存在、版本是否在支持范围内、它声明的运行时依赖是否齐全、浏览器是否已安装、项目配置是否存在。每一项不满足时给出**确定的错误码**与**可执行的修复提示**。
2. **参数安全基线**：传给 CLI 的参数向量只由 Bridge 自己构造。用户输入只有一处能进入向量，即测试文件过滤参数；它必须先通过安全校验，整条向量在 spawn 之前还要再做一次整体自检。

权威发现（`playwright test --list`）属 ATS-202（`docs/23-AUTHORITATIVE-DISCOVERY.md`），不在本文范围内。参数选项集「以已安装 CLI 的 `--help` 为准」属 ATS-301（`docs/18-RUNNER-ADAPTER-CONTRACT.md`），本文在其之上增加校验，不改变选项的取舍规则。

## 1. 模块与调用位置

| 位置 | 职责 |
|---|---|
| `server/adapters/playwright-preflight.mjs` | 环境预检。只读文件系统，**不 spawn 任何进程、不访问网络、不下载安装** |
| `server/adapters/playwright-cli.mjs` | `assertSafeTestFilter()`（过滤参数校验）、`assertSafePlaywrightArgv()`（整条向量自检），`buildPlaywrightArgs()` 在返回前调用这两者 |
| `server/index.mjs` `startRun()` | runner 为 `playwright` 时，在 `adapter.start()` 之前执行预检；不通过则 run 进入 `error`，引擎不被拉起 |
| `server/index.mjs` `POST /api/projects/:id/run` | 请求体字段白名单；`file` 先经 `readSource()` 再经 `assertSafeTestFilter()` |
| `server/core.mjs` `safeRunArgs()` | v0.1 兼容入口，同样经 `buildPlaywrightArgs()`，因此同样受校验 |

## 2. 环境预检

`preflightPlaywright(projectRoot, { env, platform, homedir, nodeVersion })` 返回：

```text
{ ok, cli, version, registry, errors: [{code, hint, detail}], warnings: [{code, hint, detail}], checks: [{name, status}] }
```

`ok` 当且仅当 `errors` 为空。`env` 是**子进程将要收到的封口环境**（ATS-212 `buildRunnerEnv()` 的结果），浏览器目录按它计算，与子进程实际看到的一致。

### 2.1 检查项与错误码

| 顺序 | 检查 | 不满足时的码 | 级别 | 修复提示 |
|---|---|---|---|---|
| 1 | 项目根目录有 `playwright.config.{ts,js,mjs,cjs,mts,cts}` | `PLAYWRIGHT_CONFIG_REQUIRED` | 阻断 | 在项目根目录放置 Playwright 配置文件 |
| 2 | 项目本地 CLI 存在（`@playwright/test` → `playwright` → `playwright-core` 的 `cli.js`） | `PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT` | 阻断 | 在项目目录执行 `npm install`（安装 `@playwright/test`） |
| 3 | CLI 所属包的 `package.json` 版本可读 | `PLAYWRIGHT_VERSION_UNKNOWN` | 警告 | 用 `npm install` 重新安装 `@playwright/test` |
| 3 | 版本落在支持范围 `>=1.58.0 <2.0.0` | `PLAYWRIGHT_VERSION_UNSUPPORTED` | 阻断 | `npm install -D @playwright/test@^1.58` |
| 4 | CLI 包 `engines.node` 声明的下限不高于 Bridge 的 Node 版本（**只读 `>=N[.M[.P]]` 这一种写法**，逐段比较完整下限） | `PLAYWRIGHT_NODE_UNSUPPORTED` | 阻断 | 升级 Node，或安装与当前 Node 匹配的 Playwright |
| 5 | CLI 包声明的 `dependencies` 中 Playwright 系的包（`playwright*`、`@playwright/*`）均可从 CLI 所在位置解析，逐级检查到 `playwright-core` | `PLAYWRIGHT_DEPENDENCY_MISSING` | 阻断 | 在项目目录执行 `npm ci`（或删除 `node_modules` 后 `npm install`） |
| 6 | 定位 `playwright-core/browsers.json` | `PLAYWRIGHT_BROWSERS_UNVERIFIED` | 警告 | 安装完整的 `@playwright/test` 后重试 |
| 6 | `installByDefault` 的浏览器（chromium、chromium-headless-shell、firefox、webkit）目录存在且含 `INSTALLATION_COMPLETE` | `PLAYWRIGHT_BROWSERS_NOT_INSTALLED` | 警告 | 在项目目录执行 `npx playwright install`（Bridge 不代为下载） |

**支持范围的依据**：`>=1.58.0` 是本仓库实测过的最低版本（`examples/sample-playwright` 声明 `^1.58.0`，`docs/22-FRONTEND-EXPORT.md` 以 1.58.x 实测，其余实测均为 1.64.1）；`<2.0.0` 排除未验证的主版本。范围是常量 `SUPPORTED_PLAYWRIGHT_RANGE`，放宽它需要新的实测证据。

**检查 4 的比较口径**：只读取 `engines.node` 中形如 `>=N`、`>=N.M`、`>=N.M.P` 的**完整下限**（允许 `v` 前缀与空白），逐段与 Bridge 的 Node 版本比较，缺省段按 `0` 计。因此 `>=22.5` 在 Node `22.1.0` 上**不通过**（下限的次版本段高于宿主），`>=22.1.0` 在 Node `22.1.0` 上通过。其他写法（`^20 || ^22`、`>20`、`>=18 <22` 等）**一律跳过**该检查（`checks` 中记为 `skipped`），因为它们表达的是范围而非单一的下限，按范围求交需要解析整个 semver 范围，超出本检查的判定口径。跳过意味着该声明未被验证为不兼容，不等于通过。

**为什么「版本不可读」与「浏览器」是警告而不是阻断**：

- npm 安装的 `@playwright/test` 一定带 `package.json`。读不到时无法判定兼容与否，判定结论是「未知」而不是「不兼容」；预检把未知如实报告为警告，真正的不兼容（版本可读且越界）才阻断。
- Playwright Test 可以只跑 API 用例（`request` fixture），不需要任何浏览器。项目用哪些浏览器取决于配置文件里的 `projects`，静态读取无法可靠判定，所以缺浏览器只报警告，并把缺少的浏览器逐个列出。用到缺失浏览器的用例由 Playwright 自己报错。

### 2.2 浏览器目录的计算

与 Playwright 1.64.1 `playwright-core` 的 registry 规则一致，并且**按子进程的封口环境**计算：

1. `PLAYWRIGHT_BROWSERS_PATH` 为 `0`：`<playwright-core>/.local-browsers`；
2. `PLAYWRIGHT_BROWSERS_PATH` 为其他非空值：该值（相对路径按项目根目录解析）；
3. 否则按平台：Linux 为 `XDG_CACHE_HOME` 或 `~/.cache`，macOS 为 `~/Library/Caches`，Windows 为 `LOCALAPPDATA` 或 `~/AppData/Local`；末尾加 `ms-playwright`。

浏览器目录名为 `<name 中 - 换成 _>-<revision>`；只有 macOS 存在 `revisionOverrides`，此时目录名为 `<name>_<platform>_special-<revision>`。

ATS-212 的封口环境不含 `PLAYWRIGHT_BROWSERS_PATH`（它是档案的保留名，也不在平台基础键里），也不含 `LOCALAPPDATA`。因此宿主上设置的 `PLAYWRIGHT_BROWSERS_PATH` **不会**传到子进程，子进程使用平台默认目录；预检按同一规则计算，报告的目录就是子进程实际查找的目录。

### 2.3 预检失败时的 run

预检在 `startRun()` 中、`run.queued` 事件之后、`adapter.start()` 之前执行。预检不通过时：

- 写 `run.error` 事件，`data = { error: <第一个阻断码>, hint, preflight }`；
- run 迁移 `queued → error`（`docs/04-DETAILED-DESIGN.md` §3 的既有边），`run.error` 为第一个阻断码，`run.errorHint` 为其修复提示，`run.preflight` 为完整报告；
- **引擎不被 spawn**，`run.pid` 与 `run.command` 均不出现。

HTTP 契约不变：默认运行请求仍是 `202`，失败体现在 run 的 `status=error` 与 `error` 码上（`docs/04-DETAILED-DESIGN.md` §7）。预检通过时 `run.preflight` 同样记录（含警告），便于事后诊断。

## 3. 参数安全基线

### 3.1 请求体白名单

`POST /api/projects/:id/run` 只接受 `file`、`capabilities`、`runner`、`env` 四个字段。其他任何字段（例如 `config`、`project`、`grep`、`args`、`cliArgs`）都以 `400 RUN_PARAMETER_NOT_ALLOWED` 拒绝，响应带 `rejected` 数组。拒绝而不是忽略：静默忽略会让调用方以为 `--config` 已经生效。

### 3.2 测试文件过滤参数

`file` 依次经过：

1. `readSource()` / `sourcePath()`（既有）：必须是 `.spec|.test` 源文件，解析后的真实路径在项目目录内（拒绝 `..` 穿越与指向项目外的符号链接）；
2. `assertSafeTestFilter()`（本任务）：
   - 必须是字符串，长度 1–500；
   - 不得含控制字符（含 NUL、CR、LF）；
   - 统一为 `/` 分隔后，不得以 `-` 开头（否则会被 CLI 当作选项）；
   - 不得是绝对路径，不得含 `:`（Playwright 把 `path:line` 解析为行号过滤，盘符同理）；
   - 不得含正则元字符 `\ ^ $ * + ? ( ) [ ] { } |`（Playwright 把位置参数当作不区分大小写的正则过滤文件；`.` 保留，因为文件名必然含点）；
   - 任一路径段不得为 `..`。

   不满足时抛 `INVALID_TEST_FILTER`，HTTP 映射为 400。

`.` 作为正则通配与子串匹配会让过滤参数在极端命名下多选文件（例如同时存在 `tests/a.spec.ts` 与 `x/tests/a.spec.ts`），这是 Playwright 过滤语义本身的精度限制，不构成注入；本基线不改写过滤参数的格式，因为现有的测试替身与真实 CLI 均以相对路径形式验证过。

### 3.3 整条向量自检

`assertSafePlaywrightArgv(args, { cli })` 在 `buildPlaywrightArgs()` 返回前执行，向量必须严格是：

```text
<cli> test [--reporter=line,json,html] [--output <绝对路径>] [--trace on] [--workers 1] [<通过 3.2 校验的过滤参数>]
```

- 第 0 项等于解析出的项目本地 CLI 路径，第 1 项为 `test`；
- 选项只能是上面四个，值固定（`--output` 的值必须是绝对路径），每个最多出现一次；
- `--config`、`-c`、`--project`、`--grep`、`--global-timeout` 等任何其他选项一律拒绝；
- 每一项都不得含控制字符。

不满足时抛 `UNSAFE_CLI_ARGUMENT`。这条自检防的是将来有人把用户输入接进向量：即使上游漏了校验，spawn 之前也会被拦下。

### 3.4 不经 shell

运行以 `spawn(process.execPath, args, { shell: false })` 启动（`server/adapters/playwright.mjs`，SEC-006），参数作为数组传递，不拼接命令字符串。预检本身不 spawn 进程。

## 4. 不在本任务范围内

- 向项目注入 `use.screenshot` / `use.video`（ATS-101 B-01 的附带建议）。CLI 没有对应选项，注入只能改写或包装项目配置，属于执行类任务；能力矩阵继续如实报告「项目未配置」。
- 把 `PLAYWRIGHT_BROWSERS_PATH` 加入 ATS-212 的平台基础键。这是 `server/env/profiles.mjs` 的范围；本任务只保证预检与子进程看到同一个目录。
- 预检的独立 HTTP 端点。预检结果随 run 记录（`run.preflight`）。
