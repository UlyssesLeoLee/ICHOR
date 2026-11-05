# ATS-CP-001 部署式控制面 API 与桌面本地 API 边界分离（ATS-506 / S5 / v1.0.0）

- 对象：AI Test Studio 的**部署式控制面 API**（P2 控制平面，`/cp/v1/*`）与**桌面本地 Bridge API**（P1，`/api/*`）之间的边界
- 上游依据：`docs/19-REMOTE-RUNNER-PROTOCOL.md`（HB-1/HB-2/HB-3/HB-4/HB-7、§3.4、§5、§6、TR-05/TR-13、ADR-015/019/021）、`docs/03-BASIC-DESIGN.md` §1/§6、`docs/12-DEPLOY-OPERATIONS.md` §2/§5、`docs/02-REQUIREMENTS.md`（FR-028）、`docs/WBS.xlsx`「开发WBS」ATS-506 行
- 完成定义：云端 API 无本地绝对路径/Token；禁止仅依赖 Tauri 特权 API
- 实现：`server/control-plane/`（`boundary.mjs`、`errors.mjs`、`auth.mjs`、`app.mjs`、`main.mjs`）
- 测试：`tests/control-plane.test.mjs`（UT-CP）、`tests/control-plane-it.test.mjs`（IT-CP）；实际输出见 `docs/evidence/ATS-506/`

## 1. 范围与状态

| 能力 | 状态 | 说明 |
|---|---|---|
| 控制面独立进程、独立端点、独立凭据、独立错误命名空间 | **IMPLEMENTED** | `node server/control-plane/main.mjs` 以纯 Node 进程启动，不经 Tauri、不导入任何本地 Bridge 模块 |
| 入站边界：本地绝对路径、路径穿越、路径/仓库地址字段、本地凭据、秘密明文拒绝 | **IMPLEMENTED** | 请求路径、查询串、请求体（键与值）全部扫描；命中即 `REMOTE_PATH_FORBIDDEN` / `REMOTE_SECRET_INLINE_FORBIDDEN` / `REMOTE_UNAUTHENTICATED` |
| 出站边界：响应体不含本地绝对路径与本地会话 Token 形态 | **IMPLEMENTED** | 每个响应发送前再扫描一次，命中即不发送、改回 `REMOTE_INTERNAL` 并记审计事件 |
| 租户上下文由会话推导、跨租户统一 404、拒绝优先 | **IMPLEMENTED** | 仅覆盖本 API 的资源（项目元数据） |
| 项目元数据按不透明 UID 登记与查询 | **IMPLEMENTED** | 进程内存储，进程重启即丢失（见 §11） |
| 用户侧 OIDC 认证 | DESIGNED（ATS-507） | 本任务只提供认证器接口；默认认证器拒绝一切；开发用静态令牌仅限回环地址 |
| RBAC、审计事件持久化与查询 | DESIGNED（ATS-508） | 本任务的审计事件只在进程内保留 |
| 作业队列、节点注册、证据后端、元数据同步、OpenAPI | DESIGNED（ATS-502/503/509/510/511） | 本 API 不提供作业、节点、证据端点 |

**FR-028 仍为 `DESIGNED`**：本任务交付的是控制面 API 的边界与骨架，不是远程执行能力。远程 Runner、队列与节点在仓库中仍不存在。

## 2. 两个 API 面的分离

| 项 | P1 本地 Bridge API | P2 部署式控制面 API |
|---|---|---|
| 入口 | `server/index.mjs`（由 `npm start` 或 Tauri 壳启动） | `server/control-plane/main.mjs`（`npm run start:control-plane`），**不由 Tauri 启动** |
| 绑定 | 只绑定 `127.0.0.1`，端口 `ATS_PORT` | 默认 `127.0.0.1:4610`（`ATS_CP_HOST`/`ATS_CP_PORT`）；非回环地址必须配置 TLS（§7） |
| 路径前缀 | `/api/*` | `/cp/v1/*`；`/api/*` 在控制面上一律 `REMOTE_POLICY_REJECTED` |
| 凭据 | 进程级随机会话 Token，`X-ATS-Token` 头 | `Authorization: Bearer <令牌>`，由认证器校验；**出示 `X-ATS-Token` 的请求一律 `REMOTE_UNAUTHENTICATED`** |
| 错误码 | `INVALID_SESSION`、`ORIGIN_NOT_ALLOWED` 等本地码 | 只用 `REMOTE_` 命名空间（`docs/19` §6.2），与本地码不重名 |
| 资源引用 | 本地绝对路径（项目根）只存在于本面 | 只用不透明 UID（`prj_…`）；任何路径形态一律拒绝 |
| 数据 | `ATS_DATA_DIR` 下的 `state.json` 与运行目录 | 不读写本地文件系统（TLS 证书文件除外）；不知道 `ATS_DATA_DIR` |
| 与 Tauri 的关系 | Tauri 壳托管本进程 | 无关系：不导入 Tauri、不需要 WebView、不需要 Tauri 命令 |

两面之间**没有调用通路**：控制面源码不导入 `server/index.mjs`、`server/core.mjs`、`server/agent.mjs`、`server/adapters/*`，不引用本地端点与本地数据目录，也不启动子进程（HB-1）；本地 Bridge 也不转发 `/cp/v1/*`（该前缀在本地面上按静态文件处理，返回 404）。

## 3. 控制面 API（`/cp/v1`）

| URL | Method | 认证 | 用途 | 成功响应 |
|---|---|---|---|---|
| `/cp/v1/health` | GET | 无 | 存活与平面标识 | `200 {ok:true, plane:"control-plane", api:"cp/v1", auth:<模式>}` |
| `/cp/v1/contract` | GET | Bearer | 机读的边界契约 | `200 {api, credential, resourceReference, forbiddenInRequests, errorNamespace, tauriRequired:false, localBridgeReachable:false}` |
| `/cp/v1/projects` | GET | Bearer | 本租户项目元数据列表 | `200 {projects:[{projectUid, displayName, createdAt}]}` |
| `/cp/v1/projects` | POST | Bearer | 登记项目元数据；请求体只允许 `displayName`（必填，1–120 字符，无控制字符）与可选 `tenantId`（必须等于会话租户） | `201 {project:{projectUid, displayName, createdAt}}`；`projectUid` 由服务端生成 |
| `/cp/v1/projects/{projectUid}` | GET | Bearer | 查询单个项目元数据 | `200 {project}`；不存在或属他租户一律 `404 REMOTE_RESOURCE_NOT_FOUND` |

其余任何路径或方法：`403 REMOTE_POLICY_REJECTED`（拒绝优先，`docs/19` §6.1）。

错误响应体固定为 `{error:<REMOTE_码>, hint:<一句可行动提示>, retryable:<bool>}`；HTTP 状态与可重试性取自 `docs/19` §10 约束块的码表（`errors.mjs` 与该块逐码一致，由 UT 守护）。错误响应**不回显**异常消息、请求内容、路径或堆栈。

## 4. 请求处理管线

每个请求按下列顺序处理，任一步拒绝即结束：

| 序 | 检查 | 拒绝结果 |
|---|---|---|
| 1 | 原始请求目标（不做 `.`/`..` 规范化）按 `/` 切分为段，逐段百分号解码；解码失败 | `403 REMOTE_POLICY_REJECTED` |
| 2 | 任一路径段或查询串的名/值含本地路径形态、路径穿越或解码后含 `/`、`\` | `422 REMOTE_PATH_FORBIDDEN` |
| 3 | 请求头含本地凭据 `X-ATS-Token` | `401 REMOTE_UNAUTHENTICATED`（原因 `local_credential_presented` 只入审计） |
| 4 | 请求头含 `Origin`（本版本不支持浏览器跨源调用控制面） | `403 REMOTE_POLICY_REJECTED` |
| 5 | 路由与方法不在 §3 表中 | `403 REMOTE_POLICY_REJECTED` |
| 6 | 需要认证的路由：认证器未确立身份 | `401 REMOTE_UNAUTHENTICATED`（原因只入审计） |
| 7 | 会话没有租户 | `403 REMOTE_TENANT_REQUIRED` |
| 8 | 客户端以 `X-ATS-Tenant` 头或 `tenantId` 查询参数给出的租户与会话租户不同 | `403 REMOTE_TENANT_MISMATCH` |
| 9 | POST：`Content-Type` 不是 `application/json` | `403 REMOTE_POLICY_REJECTED` |
| 10 | POST：请求体超过 64 KiB | `413 REMOTE_PAYLOAD_TOO_LARGE` |
| 11 | POST：请求体不是 JSON 对象，或嵌套深度超过 32 | `403 REMOTE_POLICY_REJECTED` |
| 12 | 请求体（键与值）含本地路径形态、路径/仓库地址字段 | `422 REMOTE_PATH_FORBIDDEN` |
| 13 | 请求体含凭据/秘密字段，或值呈本地会话 Token 形态 | `422 REMOTE_SECRET_INLINE_FORBIDDEN` |
| 14 | 请求体 `tenantId` 与会话租户不同 | `403 REMOTE_TENANT_MISMATCH` |
| 15 | 请求体含 §3 以外的字段或字段值非法 | `403 REMOTE_POLICY_REJECTED` |
| 16 | 处理器内部未预期异常 | `500 REMOTE_INTERNAL`（可重试，不回显消息） |
| 17 | 出站扫描：响应中任一字符串含本地路径形态或本地会话 Token 形态 | 不发送原响应，改为 `500 REMOTE_INTERNAL`，审计原因 `egress_boundary_blocked` |

每次拒绝产生一条进程内审计事件：时刻、租户（已知时）、动作、错误码、原因。

## 5. 边界判定规则（`boundary.mjs`）

### 5.1 本地路径形态

一个字符串命中以下任一规则即视为本地路径形态（`detectLocalPath` 返回规则名）：

| 规则名 | 判定 | 例 |
|---|---|---|
| `windows_drive_path` | 以盘符开头且后接分隔符或结束（`C:`、`C:\`、`C:/`），或在非字母数字字符之后出现盘符加分隔符 | `C:\repo`、`see D:/x` |
| `unc_path` | 以 `\\` 或 `//` 开头，或在空白/引号/括号/等号/逗号/分号之后出现 `\\主机\` | `\\srv\share`、`\\?\C:\x`、`//srv/share` |
| `posix_absolute_path` | 以 `/` 开头，或在空白/引号/括号/等号/逗号/分号/冒号之后出现常见系统根（`home`、`Users`、`root`、`tmp`、`var`、`etc`、`opt`、`usr`、`mnt`、`Volumes`、`private`、`srv`、`proc`、`dev`、`sys`、`run`、`media`） | `/home/alice/repo`、`at /Users/bob/x` |
| `file_url` | 含 `file:` 协议 | `file:///C:/x` |
| `home_relative_path` | 以 `~/`、`~\` 开头或等于 `~` | `~/repo` |
| `env_path` | 含 `%变量%\`、`%变量%/`、`$HOME`、`${HOME}` | `%USERPROFILE%\repo` |
| `path_traversal` | 含 `..` 路径段 | `a/../b`、`..` |
| `repository_url` | `ssh://`、`git://`、`git+ssh://` 协议，`user@host:path` 形态，或以 `.git` 结尾的 http(s) 地址 | `git@github.com:o/r.git` |

字符串同时按原样与百分号解码后（可解码时）各判定一次，`C%3A%5Crepo` 与 `C:\repo` 同等拒绝。`https://example.com/a`、`prj_<uuid>`、40 位 Git SHA、`a/b` 这类相对片段不命中。

### 5.2 字段名规则

字段名去掉 `_`、`-` 并转小写后比较：

| 类别 | 字段名 | 结果 |
|---|---|---|
| 路径字段（用路径代替 UID，HB-4） | `path`、`localpath`、`projectpath`、`root`、`projectroot`、`rootdir`、`cwd`、`dir`、`directory`、`workdir`、`workspace`、`workspacepath`、`file`、`filepath`、`absolutepath` | `REMOTE_PATH_FORBIDDEN` |
| 仓库地址字段（HB-4/HB-10） | `repository`、`repositoryurl`、`repourl`、`giturl`、`remoteurl`、`cloneurl` | `REMOTE_PATH_FORBIDDEN` |
| 凭据/秘密字段（HB-3） | `token`、`sessiontoken`、`atstoken`、`xatstoken`、`secret`、`secretvalue`、`password`、`passwd`、`apikey`、`privatekey`、`credential`、`credentials` | `REMOTE_SECRET_INLINE_FORBIDDEN` |

### 5.3 本地会话 Token 形态

本地 Bridge 的会话 Token 是 24 字节随机数的小写十六进制（48 个十六进制字符）。控制面把**恰为 48 个十六进制字符**的字符串值视为本地会话 Token 形态：入站拒绝 `REMOTE_SECRET_INLINE_FORBIDDEN`，出站拦截。Git SHA（40）与 SHA-256（64）长度不同，不受影响。

### 5.4 上限

请求体 64 KiB；JSON 嵌套深度 32；`displayName` 1–120 字符。

## 6. 认证

- 认证器是 `(req) => {subject, tenantId} | null` 形态的函数，由启动配置选择；返回 `null` 即认证未确立。
- `none`（默认）：拒绝一切需要认证的请求。正式的用户认证（OIDC）属 ATS-507，接入方式是替换认证器。
- `dev-static`（仅开发与测试）：`ATS_CP_DEV_TOKENS` 为 JSON 对象 `{令牌: 租户ID}`；令牌至少 32 字符；租户 ID 形如 `ten_` 加 1–64 个 `[A-Za-z0-9_-]`；该模式**只允许绑定回环地址**，否则拒绝启动。令牌比较使用定长摘要比较，不按长度或前缀短路。
- 认证失败对外只有 `REMOTE_UNAUTHENTICATED`；具体原因（`missing_user_token`、`unknown_user_token`、`local_credential_presented`）只写入审计事件（`docs/19` §3.4、ADR-021）。

## 7. 启动配置（`main.mjs`）

| 环境变量 | 默认 | 规则 |
|---|---|---|
| `ATS_CP_HOST` | `127.0.0.1` | 非回环地址必须同时配置 TLS，否则拒绝启动 |
| `ATS_CP_PORT` | `4610` | 1–65535 的整数；与 `ATS_PORT`（本地 Bridge 端口，已设置时）相同即拒绝启动（HB-7：不得共用同一端点） |
| `ATS_CP_TLS_CERT` / `ATS_CP_TLS_KEY` | 无 | 必须同时给出；给出时以 HTTPS 服务且最低协议 TLS 1.3 |
| `ATS_CP_AUTH` | `none` | `none` 或 `dev-static`；其它值拒绝启动 |
| `ATS_CP_DEV_TOKENS` | 无 | `dev-static` 时必填，规则见 §6 |

配置错误时进程以退出码 2 结束，标准错误只输出配置项名与原因，不输出令牌值。启动日志只输出协议、主机、端口与认证模式。

## 8. 桌面侧调用边界

- Tauri 壳（`src-tauri/src/lib.rs`）只托管本地 Bridge 进程，注册的命令只有 `local_bridge_status`；它不启动、不调用、不代理控制面。
- 前端（`apps/studio`）不使用 Tauri API；控制面不需要 Tauri 特权命令即可被任何 HTTP 客户端使用（完成定义「禁止仅依赖 Tauri 特权 API」）。
- 上述两点由 UT 静态守护：控制面目录的导入白名单、禁用引用清单，以及 `lib.rs` 的命令清单与控制面引用检查。

## 9. 与远程协议的对应

| 协议条目 | 本任务的落实 | 验证 |
|---|---|---|
| HB-1 控制平面不得调用本地 API、不得依赖 Tauri 特权 API | 控制面不导入本地模块、不引用本地端点、不启动子进程；以纯 Node 进程运行 | UT 静态守护 + IT 进程级 |
| HB-2 跨平面消息不得携带本地绝对路径 | 入站 §4 步骤 2/12 拒绝；出站 §4 步骤 17 拦截 | UT + IT |
| HB-3 不得携带秘密明文 | 凭据/秘密字段与本地 Token 形态拒绝（`REMOTE_SECRET_INLINE_FORBIDDEN`） | UT + IT |
| HB-4 项目只以不透明 UID 引用 | `projectUid` 由服务端生成；路径与仓库地址字段拒绝 | UT + IT |
| HB-7 本地与远程能力在 API 层分离，不共用凭据或端点 | §2 全表；本地 Token 在控制面无效、控制面令牌在本地面无效；端口相同拒绝启动 | UT + IT |
| §3.4 / ADR-021 认证失败统一码 | 只返回 `REMOTE_UNAUTHENTICATED`，原因入审计 | UT + IT |
| §5 / ADR-018 租户由会话推导、跨租户 404 | §4 步骤 7/8/14；跨租户 `REMOTE_RESOURCE_NOT_FOUND` | UT + IT |
| §6 / ADR-019 拒绝优先、`REMOTE_` 命名空间 | 未列举条件 `REMOTE_POLICY_REJECTED`；内部错误 `REMOTE_INTERNAL`；码表与约束块逐码一致 | UT |
| TR-05 / TR-13 | 同 HB-2/HB-4 与 HB-1/HB-7 | 同上 |
| ADR-015 控制面 API 需新建，不复用本地端点 | 独立入口与前缀 | IT |

## 10. 验证

- UT（`tests/control-plane.test.mjs`）：边界判定矩阵、字段名规则、Token 形态、深度上限、码表与 `docs/19` 约束块一致、认证器、启动配置矩阵、进程内 HTTP 管线（每个拒绝分支与成功路径）、出站拦截、静态导入守护、`lib.rs` 命令守护。
- IT（`tests/control-plane-it.test.mjs`）：以子进程同时启动本地 Bridge 与控制面（随机端口、隔离数据目录），验证两面凭据互不通用、路由互不服务、路径与 Token 入站拒绝、跨租户 404、本地数据目录与本地 Token 从不出现在控制面的任何响应中，以及控制面在没有 Tauri 的情况下完整可用。
- 证据：`bash tools/ats506-probes/collect-evidence.sh` 生成 `docs/evidence/ATS-506/` 下的日志（命令、提交、Node/Python 版本与原样输出）。

## 11. 未验证项（PENDING ≠ PASS）

1. **TLS 1.3 实机握手未执行**：`main.mjs` 以最低协议 TLS 1.3 创建 HTTPS 服务的配置由 UT 验证，真实证书下的握手与降级拒绝未在本仓库测试中执行。
2. **用户侧认证只有接口**：OIDC 属 ATS-507；`dev-static` 不是生产认证方式。
3. **控制面无持久化**：项目元数据与审计事件只在进程内，重启即丢失；持久化与审计查询属 ATS-508/509。
4. **路径形态判定是启发式的**：§5.1 覆盖 Windows、UNC、POSIX、`file:`、家目录与环境变量形态；不以常见系统根开头、且出现在字符串中间的 POSIX 路径（如 `x /custom/dir`）不在判定范围内。出站扫描是第二道防线，不是对任意文本的完备证明。
5. **浏览器跨源调用未开放**：带 `Origin` 的请求一律拒绝；UI 到控制面的元数据同步通道属 ATS-510。
6. **桌面与控制面同机部署的端口冲突检查只对已设置的 `ATS_PORT` 生效**：控制面不硬编码本地 Bridge 的默认端口。
