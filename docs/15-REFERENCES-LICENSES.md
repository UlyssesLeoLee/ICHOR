# ATS-REF-001 技术调查、官方来源与ライセンス审查

研究基准 2026-11-03。项目之间的产品理念不具有可复制代码授权，所有直接引入第三方代码应单独检查具体仓库、依赖、版本、NOTICE、LICENSE。

| 产品 / 框架 | 官方链接 | 借鉴的能力 | 许可证 / 注意 |
|---|---|---|---|
| Playwright | https://playwright.dev/docs/test-reporters | JSON/HTML/Trace reporter、CLI | Apache-2.0 相关组件；核对 npm 发布版本 |
| Next.js | https://nextjs.org/docs/app/guides/static-exports | 静态 Next UI | MIT |
| Tauri | https://v2.tauri.app/start/frontend/nextjs/ | Rust 壳/静态导出 | MIT/Apache-2.0；第三方组件另审 |
| WDIO Tauri | https://webdriver.io/docs/wdio-tauri-service | 规划的原生桌面 E2E | 依赖与服务各自许可证 |
| Kestra | https://kestra.io/docs/ui/flows | Code/No-code/Topology | Apache-2.0（核心开源仓） |
| Bruno | https://github.com/usebruno/bruno | Git-native 本地资产 | MIT（具体组件再核对） |
| Dagster | https://github.com/dagster-io/dagster | Asset Graph / Lineage | Apache-2.0（核心开源仓） |
| OpenHands | https://github.com/OpenHands/OpenHands | Agent session/workspace | 以仓库文件为准；核心 MIT |
| Backstage | https://backstage.io/docs/overview/architecture-overview/ | 插件化与实体目录 | Apache-2.0 |
| Temporal | https://docs.temporal.io/encyclopedia/event-history | 追加执行事件 | MIT（核心） |
| Allure | https://allurereport.org/docs/v2/ | Evidence Bundle | Apache-2.0 |
| YShvydak Test Dashboard | https://github.com/shvydak/yshvydak-test-dashboard | 本地 dashboard/reporter | MIT；安全模型需自己强化 |
| Qase | https://docs.qase.io/en/articles/9123660-requirements-traceability-matrix | Requirement Traceability UX | 闭源，仅借鉴公开产品形式 |
| Currents | https://docs.currents.dev/ | Run/Test/Attempt observability | 闭源，仅借鉴公开产品形式 |
| Autify Aximo | https://autify.com/products/aximo | AI 探索测试范式 | 闭源，仅借鉴产品流程 |
| Stagehand | https://github.com/browserbase/stagehand | AI browser observe/act | MIT（核对具体版本） |
| Windmill | https://github.com/windmill-labs/windmill | 可视化工作流 UX | AGPL/商业条款，避免直接复制 |
| ComfyUI | https://github.com/comfyanonymous/ComfyUI | Node/Edge UX | GPLv3，避免直接复制 |
| Plane | https://github.com/makeplane/plane | 列表与工作项体验 | AGPLv3，避免直接复制 |
| n8n | https://github.com/n8n-io/n8n/blob/master/LICENSE.md | 工作流执行历史 UX | Sustainable Use License，非宽松开源 |
| 日本 IPA | https://www.ipa.go.jp/publish/secbooks20130304.html | 共通フレーム2013 | 本项目参考工程方法，不宣称获得 IPA 官方认证 |
| 日本 IPA | https://www.ipa.go.jp/archive/digital/iot-en-ci/jyouryuu/hikinou/ent03-b.html | 非機能要求グレード | 按本项目情境设定 NFR 指标 |
| Maestro（mobile.dev） | https://docs.maestro.dev/maestro-cli | 移动端 Flow 化用例、元素检查器、设备管理模式 | Apache-2.0（CLI）；**仅借鉴管理模式，不引入依赖、不承诺语法兼容**；Studio 为独立产品 |

## 当前代码的许可证声明

本压缩包中的原创 `server/`、`apps/studio/`、`src-tauri/` 与文档均以随包 MIT LICENSE 发布（具体第三方依赖按其自身许可）。未复制任何列举竞品的源代码。

**依赖清单状态（ATS-102 交付）**：`apps/studio/package.json` 的第三方依赖（Next、React、Monaco、XYFlow 等）已生成 lockfile（`apps/studio/package-lock.json`，88 个包），并由 `tools/gen_dep_manifest.mjs` 生成了依赖清单 `docs/dependencies/dependency-manifest.{json,md}`——记录每个依赖的版本、许可、`resolved` URL 与 `integrity` 哈希。88 个依赖的许可**全部已知**，其中**强 copyleft（AGPL/GPL/SSPL/BUSL/Elastic/Commons-Clause）为 0 个**；需人工复核的有 16 个：15 个弱 copyleft（LGPL，全部是 `sharp`/`libvips` 的平台原生二进制，随 Next.js 图片优化依赖引入）与 1 个署名义务（`caniuse-lite`，CC-BY-4.0）。

**仍未完成**（不得称为已合规）：①完整 SPDX SBOM 未生成（多数包未发布 `sbomId`）；②分发审计结论未出；③上述 16 个依赖是否随产物分发、以及 notice 文件如何随包携带，须在正式闭源商业发行前逐项确认。详见 `docs/17-BUILD-CI.md` §5。
