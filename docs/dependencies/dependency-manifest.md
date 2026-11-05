# 依赖清单 / Dependency Manifest

> 本文件由 `tools/gen_dep_manifest.mjs` 从**已提交的 lockfile** 生成，请勿手工编辑。
> 重新生成：`node tools/gen_dep_manifest.mjs`；校验漂移：`node tools/gen_dep_manifest.mjs --check`。

- 许可数据来源：npm registry 元数据（`npm-registry-metadata`），非本机 `node_modules`——因此清单在各平台一致
- 依赖总数：**88**（直接依赖 10）
- 许可已知：**88**；许可未知：**0**
- 需法务复核的许可：**16**（强 copyleft 0，弱 copyleft 15，署名义务 1）

## 许可分布

| 许可 | 依赖数 |
|---|---|
| MIT | 41 |
| Apache-2.0 | 17 |
| ISC | 11 |
| LGPL-3.0-or-later | 10 |
| Apache-2.0 AND LGPL-3.0-or-later | 3 |
| BSD-3-Clause | 2 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| 0BSD | 1 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 |
| CC-BY-4.0 | 1 |

## Node Bridge (server/)（`.`）

- lockfile：`package-lock.json`（lockfileVersion 3）
- lockfile SHA-256：`d0e018ffd53f971f6874bf79264aab1efd019f928cff09c2c0e426e485e01f17`
- 依赖 0（直接 0，dev 0，可选 0）
- 许可已知 0 / 未知 0；需法务复核 0（强 0，弱 0，署名 0）

本项目**无第三方依赖**：Node Bridge 只用 Node 内置模块，测试用内置 `node:test`。
## Next.js 16 Studio UI（`apps/studio`）

- lockfile：`apps/studio/package-lock.json`（lockfileVersion 3）
- lockfile SHA-256：`c48439f68c3fabef8f3ae11fa17a4a5b0461fe3261494459b2ce753621724306`
- 依赖 88（直接 10，dev 3，可选 40）
- 许可已知 88 / 未知 0；需法务复核 16（强 0，弱 15，署名 1）

| 依赖 | 版本 | 类别 | 许可 | SPDX | 需复核 | integrity (sha512 末 16 位) |
|---|---|---|---|---|---|---|
| `@emnapi/runtime` | 1.11.3 | 传递 | MIT | — | 否 | `/qU+jvfWSCYYLA==` |
| `@img/colour` | 1.1.0 | 传递 | MIT | — | 否 | `M75mo7ixa/pCeQ==` |
| `@img/sharp-darwin-arm64` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `ehLqmEpDsRf+lg==` |
| `@img/sharp-darwin-x64` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `a0tkCNOXiAxZUw==` |
| `@img/sharp-freebsd-wasm32` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `4e+hQaWOt86iAw==` |
| `@img/sharp-libvips-darwin-arm64` | 1.3.4 | 传递 | LGPL-3.0-or-later | — | **weak** | `DarbyTpGCfEDuw==` |
| `@img/sharp-libvips-darwin-x64` | 1.3.4 | 传递 | LGPL-3.0-or-later | — | **weak** | `6p75NmTGjIhtpQ==` |
| `@img/sharp-libvips-linux-arm` | 1.3.4 | 传递 | LGPL-3.0-or-later | — | **weak** | `FxYEK1D1ZSidmw==` |
| `@img/sharp-libvips-linux-arm64` | 1.3.4 | 传递 | LGPL-3.0-or-later | — | **weak** | `BC7vAfonA/Lr1A==` |
| `@img/sharp-libvips-linux-ppc64` | 1.3.4 | 传递 | LGPL-3.0-or-later | — | **weak** | `OwB4smBRxfVpYQ==` |
| `@img/sharp-libvips-linux-riscv64` | 1.3.4 | 传递 | LGPL-3.0-or-later | — | **weak** | `63OevL5mTyOC7Q==` |
| `@img/sharp-libvips-linux-s390x` | 1.3.4 | 传递 | LGPL-3.0-or-later | — | **weak** | `nFWcK4blSgQOuQ==` |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | 传递 | LGPL-3.0-or-later | — | **weak** | `ftnj1QEKSU1zkw==` |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.3.4 | 传递 | LGPL-3.0-or-later | — | **weak** | `6baAWqnCyQ2DWA==` |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.4 | 传递 | LGPL-3.0-or-later | — | **weak** | `Tcr2mDyP4So7Fg==` |
| `@img/sharp-linux-arm` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `1rOL51lcIz48ZQ==` |
| `@img/sharp-linux-arm64` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `EtIqyo3DYsRwdQ==` |
| `@img/sharp-linux-ppc64` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `UmX1hkiZ0kdevA==` |
| `@img/sharp-linux-riscv64` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `L/yh4tvU+nCyRQ==` |
| `@img/sharp-linux-s390x` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `3jsnTcCQIgWjqA==` |
| `@img/sharp-linux-x64` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `dFQdayYIZyoNog==` |
| `@img/sharp-linuxmusl-arm64` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `nf+ZlsuZzLxQqg==` |
| `@img/sharp-linuxmusl-x64` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `sbUyLeU0ULyD1A==` |
| `@img/sharp-wasm32` | 0.35.5 | 传递 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | — | **weak** | `qxVlXaSf7IINGQ==` |
| `@img/sharp-webcontainers-wasm32` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `nFCIZ/GuDw5SUA==` |
| `@img/sharp-win32-arm64` | 0.35.5 | 传递 | Apache-2.0 AND LGPL-3.0-or-later | — | **weak** | `p1VM+p/AuEtm6Q==` |
| `@img/sharp-win32-ia32` | 0.35.5 | 传递 | Apache-2.0 AND LGPL-3.0-or-later | — | **weak** | `On/BHBxkBeKr6A==` |
| `@img/sharp-win32-x64` | 0.35.5 | 传递 | Apache-2.0 AND LGPL-3.0-or-later | — | **weak** | `DhFA9KnURwpfqg==` |
| `@monaco-editor/loader` | 1.7.0 | 传递 | MIT | — | 否 | `shohfKLVT6crVA==` |
| `@monaco-editor/react` | 4.7.0 | 直接 | MIT | — | 否 | `p3w4s9R6oe1eCA==` |
| `@next/env` | 16.4.5 | 传递 | MIT | — | 否 | `gTqaj96yuLp6Xw==` |
| `@next/swc-darwin-arm64` | 16.4.5 | 传递 | MIT | — | 否 | `WWmoQajXtX/O8A==` |
| `@next/swc-darwin-x64` | 16.4.5 | 传递 | MIT | — | 否 | `DWNt/6oWlamrrw==` |
| `@next/swc-linux-arm64-gnu` | 16.4.5 | 传递 | MIT | — | 否 | `6NzbCL2FPDrrgw==` |
| `@next/swc-linux-arm64-musl` | 16.4.5 | 传递 | MIT | — | 否 | `yGD/VfA16jEK7Q==` |
| `@next/swc-linux-x64-gnu` | 16.4.5 | 传递 | MIT | — | 否 | `72Fzn2lI+Q+vAw==` |
| `@next/swc-linux-x64-musl` | 16.4.5 | 传递 | MIT | — | 否 | `sGZamJI7KFOdZw==` |
| `@next/swc-win32-arm64-msvc` | 16.4.5 | 传递 | MIT | — | 否 | `JIwKtMxOsp5GBA==` |
| `@next/swc-win32-x64-msvc` | 16.4.5 | 传递 | MIT | — | 否 | `PDcX15+RrgUhiw==` |
| `@swc/helpers` | 0.5.23 | 传递 | Apache-2.0 | — | 否 | `9whaL/sqN13afw==` |
| `@types/d3-color` | 3.1.3 | 传递 | MIT | — | 否 | `I+0sEtqDqy2b4A==` |
| `@types/d3-drag` | 3.0.7 | 传递 | MIT | — | 否 | `U6KJHvqxKzTxxQ==` |
| `@types/d3-interpolate` | 3.0.4 | 传递 | MIT | — | 否 | `48q2IAolKKo1MA==` |
| `@types/d3-selection` | 3.0.12 | 传递 | MIT | — | 否 | `4kSnfzBYkTzpgw==` |
| `@types/d3-transition` | 3.0.9 | 传递 | MIT | — | 否 | `tREJKkPfXkZuCg==` |
| `@types/d3-zoom` | 3.0.9 | 传递 | MIT | — | 否 | `Kfsn0qghgdepMA==` |
| `@types/node` | 22.20.5 | 直接(dev) | MIT | — | 否 | `/hKmfDH0Ris4aA==` |
| `@types/react` | 19.3.0 | 直接 | MIT | — | 否 | `JSwF4ZS1s4viQg==` |
| `@types/react-dom` | 19.3.0 | 直接 | MIT | — | 否 | `3rylQtV2hym44Q==` |
| `@types/trusted-types` | 2.0.7 | 传递 | MIT | — | 否 | `2MZaX0cwDuXsfw==` |
| `@xyflow/react` | 12.12.1 | 直接 | MIT | — | 否 | `kuLkz0JbSYu5Cw==` |
| `@xyflow/system` | 0.0.84 | 传递 | MIT | — | 否 | `JNtzrETscwnkEA==` |
| `baseline-browser-mapping` | 2.11.35 | 传递 | Apache-2.0 | — | 否 | `Yw34Qf9CQ3u1qQ==` |
| `caniuse-lite` | 1.0.30001820 | 传递 | CC-BY-4.0 | — | **attribution** | `N/q8c/5u/7Gz8w==` |
| `classcat` | 5.0.5 | 传递 | MIT | — | 否 | `Z2UGCcQ9lR6p6w==` |
| `client-only` | 0.0.1 | 传递 | MIT | — | 否 | `aCxrrcfu8I8rMA==` |
| `csstype` | 3.2.3 | 传递 | MIT | — | 否 | `X8T/0kCiOYpAIQ==` |
| `d3-color` | 3.1.1 | 传递 | ISC | — | 否 | `qT+FlAdPKYRilA==` |
| `d3-dispatch` | 3.0.2 | 传递 | ISC | — | 否 | `/Haem7m+lu98Sg==` |
| `d3-drag` | 3.0.1 | 传递 | ISC | — | 否 | `cbM6fqq7C0tbPA==` |
| `d3-ease` | 3.0.2 | 传递 | BSD-3-Clause | — | 否 | `kU6SlV4J3gak1w==` |
| `d3-interpolate` | 3.0.2 | 传递 | ISC | — | 否 | `42yBNo0STPqnzQ==` |
| `d3-selection` | 3.0.1 | 传递 | ISC | — | 否 | `YcWutbZDIxe/Xg==` |
| `d3-timer` | 3.0.2 | 传递 | ISC | — | 否 | `1196pmaQ1fK90A==` |
| `d3-transition` | 3.0.2 | 传递 | ISC | — | 否 | `cbv2m7O7y8NTOQ==` |
| `d3-zoom` | 3.0.1 | 传递 | ISC | — | 否 | `zoomSD3Cn2zwiw==` |
| `detect-libc` | 2.1.2 | 传递 | Apache-2.0 | — | 否 | `/of7io4mzihBtQ==` |
| `dompurify` | 3.4.15 | 传递 | (MPL-2.0 OR Apache-2.0) | — | **weak** | `v6wUxJUwwv+Xyw==` |
| `lucide-react` | 0.468.0 | 直接 | ISC | — | 否 | `f3oV4IsYhi4JFA==` |
| `marked` | 14.0.0 | 传递 | MIT | — | 否 | `2WClxHkzOOuryQ==` |
| `monaco-editor` | 0.57.0 | 传递 | MIT | — | 否 | `p4cx/PWm3kI/5A==` |
| `nanoid` | 3.3.20 | 传递 | MIT | — | 否 | `RaDqX5uPFYJ4ZQ==` |
| `next` | 16.4.5 | 直接 | MIT | — | 否 | `U54kaifLCdXbBw==` |
| `picocolors` | 1.1.1 | 传递 | ISC | — | 否 | `ceP2ntpaHrDEVA==` |
| `postcss` | 8.5.23 | 传递 | MIT | — | 否 | `6vlfCD7oXvRwgg==` |
| `react` | 19.3.1 | 直接 | MIT | — | 否 | `XpKlHL69gO38yw==` |
| `react-dom` | 19.3.1 | 直接 | MIT | — | 否 | `Le+ZeBCavQPtKQ==` |
| `scheduler` | 0.28.0 | 传递 | MIT | — | 否 | `1+xKBmHXJsczAw==` |
| `semver` | 7.8.6 | 传递 | ISC | — | 否 | `PoLP8DpCHqHIJw==` |
| `sharp` | 0.35.5 | 传递 | Apache-2.0 | — | 否 | `8IR1QqvzHyjC7g==` |
| `source-map-js` | 1.2.2 | 传递 | BSD-3-Clause | — | 否 | `xeHywEfNXNP3Vw==` |
| `state-local` | 1.0.7 | 传递 | MIT | — | 否 | `7REb7COQ0UR59w==` |
| `styled-jsx` | 5.1.6 | 传递 | MIT | — | 否 | `LSRA2pu6n0XYZA==` |
| `tslib` | 2.9.1 | 传递 | 0BSD | — | 否 | `hQgXDTYoiCxnWA==` |
| `typescript` | 5.9.3 | 直接(dev) | Apache-2.0 | — | 否 | `Lpp8wtm6M5TgSw==` |
| `undici-types` | 6.21.0 | 传递(dev) | MIT | — | 否 | `PMlt2Md0T9H9JQ==` |
| `use-sync-external-store` | 1.7.0 | 传递 | MIT | — | 否 | `emhWMRvDmMcY8A==` |
| `zustand` | 4.5.7 | 传递 | MIT | — | 否 | `DDzMbQsuesHWlw==` |

## 说明

- 本清单只记录**本仓库自身**的依赖。被测项目的依赖不在此范围内。
- `integrity` 取自 lockfile，即 npm 安装时校验的哈希；完整值见 `dependency-manifest.json`。
- 标为「可选」的条目是各平台的原生二进制（如 `@next/swc-*`、`@img/sharp-*`），只有对应平台才会安装。
- 「需复核」列给出的是**复核等级**：`strong`（AGPL/GPL/SSPL/BUSL/Elastic/Commons-Clause，强 copyleft 或源码可得）、`weak`（LGPL/MPL/EPL/CDDL，弱 copyleft）、`attribution`（CC-BY-*，署名义务）。等级只表示「须由人确认」，不表示该许可禁止本产品的用法。
- SPDX 列多数为「—」：这些包在 `package.json` 与 registry 元数据中均未声明 `sbomId`，因此**无法给出 SPDX 标识**。清单如实记录该缺失，不以推测值填充。
- 本清单覆盖 NFR-012 所要求的 SPDX 依赖清单与分发审计的**数据基础**；正式发行前的审计结论本身仍属未完成项（见 `docs/16-BASELINE-ADR.md` §7）。
