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

## 当前代码的许可证声明

本压缩包中的原创 `server/`、`apps/studio/`、`src-tauri/` 与文档均以随包 MIT LICENSE 发布（具体第三方依赖按其自身许可）。未复制任何列举竞品的源代码。`apps/studio/package.json` 含 Next、React、Monaco、XYFlow 等依赖声明，尚未生成 lockfile/SBOM，正式闭源商业版必须进行 SPDX/依赖供应链审查和版本锁定。
