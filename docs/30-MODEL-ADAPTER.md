# ATS-403 ｜ 可替换模型 API 适配器与错误回退

- WBS：ATS-403 ｜ 阶段 / 目标版本：S4 / v0.4.0 ｜ 工作流：模型 ｜ 主责：AI（AI / 模型适配）
- 契约标识：`ai-adapter/v1` ｜ 实现载体：`server/ai/`
- 关联要件：FR-024（AI 生成）｜ 前置依赖：ATS-401（`done`）、ATS-402（`done`）
- 状态口径：本文件描述的是**已实现并经实测的适配层**。**没有用真实模型与真实密钥
  端到端验证**——所有网络行为都是用注入的 `fetch` 做的确定性验证（§7）。
  模型输出**仍然不写入仓库**：适配层只产出文本，提案落地是后续任务。

## 1. 交付范围与边界

| 属于 ATS-403（本次已实现） | 不属于 ATS-403（后续任务） |
|---|---|
| 两种兼容协议的请求/响应翻译（`openai-chat`、`anthropic-messages`） | 用真实模型 + 真实密钥做端到端验证（需真实凭据与外网） |
| 协议转换 / 传输 / 提供商 / 回退链 / 编排 五层分离 | 运行时隔离（模块沙箱、只读挂载、子进程沙箱）——与 ATS-401 §6 同一缺口 |
| 可配置的提供商列表，列表顺序即回退顺序 | 模型输出落地（应用 diff、更新 expected、Git 提交） |
| 稳定的 `AI_*` 错误码与表驱动的 HTTP 状态映射 | 流式响应（SSE）与工具调用（tool use）往返 |
| 传输层强制超时、错误分类 | 令牌计量、成本核算、按 token 的预算 |
| 外传闸门前置、密钥只在发请求时从凭据库取 | 多租户的提供商配额与路由策略 |

**完成定义（验收标准）的落实**：验收标准是「**至少两种兼容协议可配置**；
**超时/限流不污染工作区**」。两条都**已成立并有实测证据**：

- 两种协议可配置：`GET /api/ai/contract` 暴露 `protocols: ["openai-chat",
  "anthropic-messages"]`，`POST /api/ai/providers` 按协议落配置，两个协议的请求体、
  响应取文位置与认证头各自独立翻译（§3）。
- 超时/限流不污染工作区：适配层**不写任何文件**；限流与超时之后，项目目录的
  文件清单与逐文件 SHA-256 与调用前**逐字节一致**（§6.3 与证据日志）。

## 2. 分层

```
service.mjs     编排：外传闸门(ATS-402) → 凭据解析(ATS-402) → 回退链 → 契约收敛(ATS-401)
   │
   ├── fallback.mjs   回退链：只在可恢复错误上换提供商，每个提供商最多试一次
   │     │
   │     └── provider.mjs   提供商：端点/模型/凭据引用/期限，密钥在发请求时解析
   │           │
   │           └── transport.mjs   唯一的网络 I/O 层：AbortController 超时、状态码分类
   │                 │
   │                 └── protocols.mjs   协议转换：请求体、认证头、响应取文（无 I/O）
   │
   └── errors.mjs   稳定的 AI_* 错误码、可重试性、HTTP 状态映射、解释
```

分层的**可检验**理由：协议层不含任何 I/O，所以「OpenAI 的请求体长什么样」这类
问题不需要网络就能单测；网络只在 `transport.mjs` 一处，所以「超时怎么算」只有
一个实现；密钥解析只在 `provider.mjs` 一处，所以「密钥从哪来」只有一个答案。

## 3. 两种兼容协议

| | `openai-chat` | `anthropic-messages` |
|---|---|---|
| 端点 | `https://api.openai.com/v1/chat/completions` | `https://api.anthropic.com/v1/messages` |
| 指令 | `messages[0]`（role `system`） | 顶层 `system` 字段 |
| 输入 | `messages[1]`（role `user`） | `messages[0]`（role `user`） |
| 认证头 | `authorization: Bearer <key>` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |
| 取文 | `choices[0].message.content` | `content[]` 里 `type === "text"` 的块拼接 |
| 截断 | `choices[0].finish_reason === "length"` | `stop_reason === "max_tokens"` |

两者的**请求体形状、认证机制、响应取文位置都不同**，所以「兼容」不是同一份
JSON 换个字段名，而是各自一套翻译。协议层把 ATS-401 的统一请求
（`{ instructions, inputs, budget }`）翻译成对应协议的请求体，指令与输入内容
**分列**（指令不与输入内容混在一段文本里）。

**截断的输出不可用**：`finish_reason`/`stop_reason` 表示长度截断时，文本是半个
JSON，传输层直接判为 `AI_PROVIDER_OUTPUT_INVALID`，不把半个提案交给上层。

## 4. 密钥：从凭据库取，不进配置

ATS-402 已经把「密钥本体在系统凭据库、磁盘只留引用」这件事做完了。ATS-403
**只消费**那个引用：

- provider 配置里**只允许** `credentialId`（引用）。出现 `apiKey`、`secret`
  等明文字段，或配置自带 `Authorization` / `x-api-key` 头，一律
  `AI_PROVIDER_CONFIG_INVALID`（协议层 `validateProtocolConfig`）。
- 密钥在**发请求的那一刻**由 `credentialStore.resolve(id, 'ai-provider')` 取出，
  只进入认证头。它**不进** URL、**不进**请求体、**不进**状态文件、**不进**日志、
  **不进**错误消息；provider 的 `describe()` 也不带它（`server/ai/provider.mjs`）。
- 凭据库不可用 → `AI_CREDENTIAL_UNAVAILABLE`，**不是** provider 错误，因此
  **不触发回退**（回退到下一个提供商也拿不到密钥，只会再失败一次）。

这条链路的证据：IT `IT-AIE-004`（明文密钥的配置被拒且**未落库**）、UT
`UT-AIP-002`（构造 provider 时**不**解析密钥，只在调用时解析一次）、
`UT-AIP-006`（provider 的描述里没有密钥）、探针 signal 2（密钥只在认证头里，
URL 与请求体里都没有）。

## 5. 外传闸门前置

一次调用的顺序是**固定**的，由 `server/ai/service.mjs` 的 `complete()` 保证：

1. `authorize()` —— ATS-402 的外传闸门。**不通过就不往下走**：
   不读文件、不取密钥、不发请求。
2. 密钥解析 —— 每个 provider 在自己发请求时解析自己的凭据引用。
3. 回退链 —— 只在可恢复错误上换提供商。
4. 契约收敛 —— ATS-401 的提案形状由契约层负责。

被拒绝的调用**照常写外传审计**（`egress.denied`），所以「拦住了」和「留了痕」
是同一段代码的两面。

证据：UT `UT-AIS-002`/`003`（无授权 → `AI_EGRESS_DENIED` + 审计一条）、
IT `IT-AIE-006`/`007`/`008`（真实 HTTP：无授权时请求在到达提供商之前就被拒，
拒绝进了审计）、探针 signal 3（永远放行的闸门作为负控，证明这条检查不是恒真）。

## 6. 错误分类与回退

### 6.1 错误码

| 码 | 含义 | 可恢复 | HTTP |
|---|---|---|---|
| `AI_PROVIDER_TIMEOUT` | 超时 | **是** | 504 |
| `AI_PROVIDER_RATE_LIMITED` | 限流（429） | **是** | 429 |
| `AI_PROVIDER_UNAVAILABLE` | 提供商不可用（5xx/网络失败） | **是** | 503 |
| `AI_PROVIDER_SERVER_ERROR` | 提供商服务端错误 | **是** | 502 |
| `AI_PROVIDER_AUTH_FAILED` | 鉴权失败（401/403） | 否 | 401 |
| `AI_PROVIDER_CONFIG_INVALID` | 配置非法 | 否 | 400 |
| `AI_PROVIDER_REQUEST_INVALID` | 请求非法（400 等） | 否 | 400 |
| `AI_PROVIDER_RESPONSE_INVALID` | 响应不是 JSON | 否 | 502 |
| `AI_PROVIDER_OUTPUT_INVALID` | 响应没有可用文本 / 被截断 | 否 | 502 |
| `AI_CREDENTIAL_UNAVAILABLE` | 凭据库不可用 | 否 | 503 |
| `AI_EGRESS_DENIED` | 外传未获授权 | 否 | 403 |
| `AI_FALLBACK_EXHAUSTED` | 链上全部可恢复错误 | 否 | 502 |
| `AI_STEPS_EXCEEDED` | 步数预算用尽 | 否 | 400 |

分类是**表驱动**的（`server/ai/errors.mjs` 的 `AI_STATUS_FOR_CODE` 与
`classifyProviderStatus`），不靠解析错误消息文本——上游换个措辞不会改变分类。

### 6.2 回退链的规则

- **只有可恢复错误才换提供商。** 鉴权失败、配置非法、请求非法、凭据不可用
  **立即失败**：换到下一个提供商也解决不了同一个坏密钥或同一份坏配置。
- **每个提供商在链上最多尝试一次。** 重试与供应商切换是两种语义：传输层
  **不做重试**（`transport.mjs` 明确不重试），回退是换供应商，不是重复打同一个。
- 链上全败 → `AI_FALLBACK_EXHAUSTED`，`details.attempts` 带上每一次尝试
  （提供商、是否成功、错误码）。
- 提供商列表的**顺序就是回退顺序**（`GET /api/ai/providers` 的 `fallbackOrder`）。

证据：UT `UT-AIF-001`~`011`、探针最后一段（限流后换下一个；鉴权失败后第三个
提供商**从未被尝试**）。

### 6.3 失败不污染工作区

适配层**不写任何文件**：没有缓存、没有临时文件、没有「失败也留一份」的痕迹。
限流、超时、链路失败之后，项目目录的**文件清单**与**逐文件 SHA-256** 与调用前
完全一致。

证据：UT `UT-AIS-006`、探针 signal 4（负控：故意往项目里写文件的坏提供商，
必须被检测到——否则「目录没变」这条检查就是恒真的）。

## 7. API

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/ai/contract` | GET | 契约：协议、错误码、可重试错误码、密钥策略、回退策略 |
| `/api/ai/providers` | GET | 已配置的提供商与回退顺序 |
| `/api/ai/providers` | POST | 配置一个提供商（**不允许**明文密钥） |
| `/api/ai/providers/{id}` | DELETE | 移除一个提供商 |
| `/api/ai/complete` | POST | 一次真实调用（先过闸门，再走回退链） |
| `/api/ai/egress/check` | POST | **只判闸门**，不发请求（诊断用） |

`/api/diagnostics` 里的 `aiAdapter` 段报告契约版本、支持的协议、已配置的提供商
与回退顺序、密钥策略与「没有授权就不外发」这条约束。

**默认没有连接任何提供商**：`store.aiProviders` 初始为空数组，所以不配置就没有
任何外发路径。

## 8. 未实现与未验证

| 项 | 状态 | 说明 |
|---|---|---|
| 真实模型 + 真实密钥端到端 | **未验证** | 本次不持任何真实密钥、未向任何真实服务商发过请求；所有网络行为都是注入的 `fetch`（`tools/ats403-probes/probe-ai-boundary.mjs` 与 `tests/ai-api.test.mjs` 的假端点）。**PENDING ≠ PASS** |
| ST-032（触发外传 + 网络抓包） | **仍 PENDING** | ATS-402 已执行并 PASS 的是它的前半段（预览→确认→放行）。ATS-403 交付了外发路径，但**没有真实目标端点**，因此仍无法完成「触发外传 + 抓包」 |
| 运行时隔离（模块沙箱 / 只读挂载 / 子进程） | 未实现 | 与 ATS-401 §6 是同一缺口：静态检查证明契约层不含 I/O 调用，但这**不是**运行时隔离 |
| 模型输出落地 | 未实现 | 仓库中仍不存在把模型输出写入仓库的代码路径；适配层只产出文本 |
| 流式响应 / 工具调用往返 | 未实现 | 只处理非流式响应；`anthropic-messages` 的 `tool_use` 块被跳过而不是执行 |
| 令牌计量与成本 | 未实现 | `budget.maxOutputBytes` 等上限被校验，但响应里的实际用量未采集 |
| macOS / Linux 凭据库后端真机实测 | 未验证 | 属 ATS-402 的同一缺口，本次不依赖它 |

**不得声称的能力**：**没有**用真实模型验证过任何一条链路。已验证的是**适配层
本身**——协议翻译、错误分类、回退语义、密钥来源、闸门顺序、工作区不变性。

## 9. 复现命令

```
node --test tests/ai-adapter.test.mjs            # UT 58 项
node --test tests/ai-api.test.mjs                # IT 13 项
node tools/ats403-probes/probe-ai-boundary.mjs   # 边界探针 37 项
python tools/ats403-probes/check-wbs-ats403.py   # WBS 行与总览叙述的只读核对
npm test                                         # 全量 1571 项（1554 通过 / 17 跳过 / 0 失败）
```

证据日志在 `docs/evidence/ATS-403/`。整份证据可由一条命令重采：

```
bash tools/ats403-probes/capture-evidence.sh
```

该脚本逐步执行并把每一步的真实输出与退出码写进 `docs/evidence/ATS-403/`；
任何一步失败，脚本以非零码退出并指明是哪一步（不会把失败记成通过）。
