# ATS-SEC-001 セキュリティ設計・リスク評価

## 1. 信任边界

受信任：操作本地工作台的用户、Node Bridge 主进程、本地项目与操作系统当前用户。**不默认信任**：从互联网克隆的代码、任意网页、测试目标站点 DOM、LLM 输出、Trace/截图内容、外部工具与第三方依赖。v0.1 在**可信本地仓库**这一前提下运行：Playwright 启动测试时等同执行项目源代码，可能拥有宿主机用户权限。

```mermaid
flowchart LR
 Browser[Browser / Tauri] -->|Origin + token| API[127.0.0.1 Node Bridge]
 API -->|explicit file allowlist| Git[Trusted Git Working Tree]
 API -->|child process| Runner[Playwright Execution]
 Runner --> Target[Test Target / Internet]
 Runner --> Evidence[Local Artifacts]
 Malicious[Untrusted Origin] -. denied .-> API
```

## 2. 当前已有的控制

| 控制 ID | 措施 | 代码和限制 |
|---|---|---|
| SEC-001 | 仅 loopback 监听 | `server.listen(PORT,'127.0.0.1')`，不能直接远程访问 |
| SEC-002 | Host/Origin 限制 | Host=localhost/127.0.0.1 + allowlist；本地端口劫持未解决 |
| SEC-003 | 临时本地 Token | `/api/session` 为当前进程随机 token；同机其他进程可能访问 |
| SEC-004 | 文件路径规范化 | `realpath` + `isSubpath` + 文件后缀；拒绝 traversal/symlink |
| SEC-005 | 脚本更新冲突控制 | SHA-256 旧内容不匹配拒绝覆盖 |
| SEC-006 | 不接收任意 CLI 命令 | `spawn(process.execPath,args,{shell:false})` |
| SEC-007 | 附件隔离 | 每 Run 独立目录；附件下载 token 与 `Content-Disposition` |
| SEC-008 | 不自动向云端上传 | 无云账户/AI 服务自动调用；本机 UI/运行服务 |
| SEC-009 | Agent 契约层无写入能力 | `server/agent.mjs` 只 import `node:crypto`/`node:path` 且源码不含任何 I/O 调用（静态检查守护）；写入与提交类能力在请求层被拒；提案 `approval` 恒为 `pending` 且提案人不得自审。**运行时隔离（模块沙箱/只读挂载/子进程）未实现，属 ATS-403** |
| SEC-010 | 插件契约层的权限边界 | `server/plugins/contract.mjs` + `server/plugins/sdk.mjs`：插件 Manifest **声明**权限，宿主按策略档位**授予**，生效集合 = 声明 ∩ 档位 ∩ 封闭词汇表；越权调用被拒且**被拒本身进审计**；插件作用域由宿主授予（Manifest 不带 scope）；证据 SHA-256 由宿主 resolver 计算，插件不能自报；插件结论是提案（`approval` 恒为 `pending`）且提案人不得自审。**插件宿主与沙箱未实现，属 ATS-502/503/506 与 ATS-403** |
| SEC-011 | 权威发现的信任闸门（ATS-202） | `playwright test --list` **不是只读操作**：实测它加载项目配置（执行配置顶层代码）并**执行测试文件顶层代码**（`tools/ats202-probes/list-ground-truth.mjs` §6，33 项断言）。因此 `--list` 只在用户显式背书的**可信项目**上运行；未可信项目回退到静态索引并说明原因（`discovery: 'static'`、`authoritative.outcome: 'SKIPPED_UNTRUSTED'`），即使用户显式请求 `?authoritative=true` 也不执行。信任记录按项目 UID 持久化在 `state.json.trust`，可随时撤销。**沙箱化仍未实现：可信项目仍以宿主用户权限执行仓库代码，属 ATS-415** |

## 3. 不可忽略的剩余风险

| 风险 | 影响 | 等级 | P1 缓解 |
|---|---|---|---|
| 恶意测试脚本写/删宿主文件 | 极高 | HIGH | Docker/VM 只读 workspace、权限最小化、网络 allowlist |
| Tauri shell 与 Node bridge 尚未打包 | 无法直接商用发行 | HIGH | sidecar bundle + 签名 + 安装/升级策略 |
| session token 同机可请求；固定 4577 端口 | 其他同机进程干扰 | HIGH | IPC/Unix domain socket/named pipe、随机端口、OS 身份验证 |
| 测试报告含口令、PII、cookie | 泄露与隐私违规 | HIGH | 视觉脱敏、日志清洗、证据加密及保留期 |
| JSON 状态持久化未设置单写锁 | 多实例损坏或丢更新 | MEDIUM | SQLite WAL/文件锁/进程唯一实例 |
| 未签名 Evidence Manifest | 本地高权限可篡改 | MEDIUM | WORM、签名、远端哈希证明 |
| 依赖 lockfile 已生成，但 SPDX SBOM/漏洞扫描/许可证审核未做 | 供应链与发行风险 | MEDIUM | 依赖清单已生成（`docs/dependencies/`）；待补 SBOM + 漏洞扫描 + 许可证审核 |
| HTML 报告可能存在主动内容 | XSS/浏览器安全 | MEDIUM | 下载而不是在管理源直接执行 HTML |
| UI Monaco 编辑任意源码缺严格 diff 审批 | 人为误修改 | MEDIUM | Git diff review + code review policy |
| AI 自主修复更改 expected 导致掩盖 Bug | 测试完整性 | HIGH (P1) | 禁止无审批断言更新/必须重测/Reviewer 角色（Agent 契约 v1 已在能力层禁用 `update_expected`） |

## 4. 安全验收

ST-014/015/023 为当前最低安全实机验证。商业/企业发行额外要求：沙箱化执行、凭据保险箱、角色授权、网络分区、证据脱敏、SBOM、签名更新及渗透测试。**没有以上控制前，不能将工作台部署为公网远程服务**。
