# ATS-DD-031 真实浏览器 PASS/FAIL 测试仓库与回归夹具（ATS-107）

本文定义 **ATS-107** 的交付物：一个真实浏览器的 PASS/FAIL 测试仓库，以及验证「结果和错误信息与 CLI 一致」的回归夹具与对账口径。

WBS 行 ATS-107 的验收口径是：

> **Chromium 上至少 1 PASS 1 FAIL；结果和错误信息与 CLI 一致**

这句话有两个都必须在**真实运行**里才成立的部分：

1. PASS 与 FAIL 必须来自**真实 Chromium**，不能是 mock、不能是双桩；
2. 「与 CLI 一致」必须是一次**比较**，因此必须存在一个**独立的 CLI 运行**作为比较的基准。

ATS-106（`docs/26-RUNNER-PREFLIGHT.md`）修复了阻断真实浏览器链路的致命缺陷 B-01；本项在它之上把这条链路真正跑通并留下可复现的证据。

## 1. 交付物

| 位置 | 职责 |
|---|---|
| `examples/real-browser-fixture/` | **真实浏览器测试仓库**：独立 Playwright 工程，依赖由 lockfile 固定；一条离线 PASS、一条故意 FAIL |
| `examples/real-browser-fixture/tests/expected.json` | 夹具**自己的期望结论**（作为数据入库），对账的第三个独立来源 |
| `tools/ats107-probes/st-ats107.mjs` | 系统测试探针：用真实 Bridge 跑该夹具，并与独立的 CLI 直跑逐条对账 |
| `tools/ats107-probes/compare.mjs` | 对账逻辑（纯函数），被探针与负控共用 |
| `tools/ats107-probes/mutation-check.mjs` | **负控**：对账逻辑的变异测试，证明该对账不是恒真的 |
| `tools/update_wbs_ats107.py` | WBS 同步器（ATS-107 行 + 总览缓存与叙述单元格） |
| `docs/evidence/ATS-107/` | 证据（探针输出、负控输出、WBS 同步结果） |

## 2. 夹具：为什么是独立工程

WBS 行 ATS-107 的备注要求：「本项的真实浏览器夹具须在 apps/studio 或独立工程内以 lockfile 固定依赖」。本项取**独立工程**：

- `apps/studio` 是 Next.js 界面，把 Playwright 用例树放进去会把 UI 的依赖锁文件与浏览器引擎绑在一起；
- 独立工程让「锁文件」这件事可被单独验证：`package.json` 里是精确版本，`package-lock.json` 入库。

仓库里已有的 `examples/sample-playwright` 是 ATS-301 的**通用**适配器夹具：它的版本是 `^1.58.0`（caret 区间），且没有入库的 lockfile。ATS-107 需要的恰好是相反的性质，所以另立一个工程，而不是改通用夹具。

| 性质 | `examples/sample-playwright` | `examples/real-browser-fixture` |
|---|---|---|
| 依赖写法 | `^1.58.0`（区间） | 精确固定 `1.65.0` |
| 入库 lockfile | 无（`examples/*/package-lock.json` 被忽略） | **有**（`.gitignore` 里显式反忽略） |
| 一次运行的结论 | 1 pass + 1 fail | 1 pass + 1 fail（按契约） |
| 用途 | 通用适配器夹具 | ATS-107 验收夹具 |

### 2.1 夹具的契约

`playwright.config.ts`：

```ts
export default defineConfig({
  testDir: './tests',
  use: { browserName: 'chromium' },
  timeout: 20000,
  retries: 0,
});
```

- **`browserName: 'chromium'` 是显式的**。验收口径点名 Chromium，留空时由引擎默认值决定，这条口径就没有被证明。
- **`retries: 0`**。一次重试会把那条故意的失败变成 flaky 用例，而 flaky 是第四种状态，对账的计数器就不再是「1 通过 1 失败」。

两条用例都是**离线**的（`page.setContent()`），因此结论只取决于引擎是否真的跑起来，不取决于网络。

`tests/expected.json` 是夹具**自己的期望结论**，作为数据入库。它是对账的第三个来源：夹具的行为变了，这个文件必须一起变，否则探针会失败，而不是悄悄接受新行为。

## 3. 对账口径：与 CLI 一致

### 3.1 基准从哪来

最省事、也是**错的**做法，是拿 Bridge 自己的 summary 当期望值去比 Bridge。那是恒等式：一个把失败用例报成通过的 Bridge，在这种比较下照样通过。

所以本项的期望值来自**两个与 Bridge 无关的来源**，且三者必须彼此一致：

1. **独立的 CLI 直跑**——引擎自己的报告，由**探针自己的遍历器**读出（不是用产品的 `parseReport`：若两边都用产品解析器，解析器里的 bug 会自己藏起来，两边会因为「错得一样」而一致）；
2. **夹具的 `tests/expected.json`**——夹具承诺的结论；
3. **Bridge 的运行结果**——被测对象。

三者的比较项：

| 比较 | 含义 |
|---|---|
| 逐条判定 | 每条用例在两边的 status 完全相同 |
| 计数器 | passed / failed / total 三项相同 |
| 错误信息 | Bridge 报出的失败原因**就是引擎自己写的**，既不丢弃也不改写 |

### 3.2 错误信息为什么用「包含」而不是「相等」

引擎的错误信息带 ANSI 转义序列，也带 call log。产品若将来剥掉 ANSI，严格相等就会断，而验收口径并没有要求逐字节相等——它要求的是**引擎自己的错误文本到达了读者面前**。

所以对账做的是**包含**检查：引擎写下的断言文本必须出现在 Bridge 的那份错误信息里。探针同时打印两边的长度与去 ANSI 后的文本，评审者能自己看到差别。

### 3.3 负控：对账逻辑非恒真

只喂一份诚实结果的对账，无法证明它会工作——它对不诚实的结果也会照样放行。

因此对账逻辑抽成纯函数模块 `compare.mjs`，并由 `mutation-check.mjs` 喂进 **10 种变异**，要求每一种都被抓住：

| 变异 | 模拟的缺陷 |
|---|---|
| M1 | 把失败用例算成通过 |
| M2 | 报成 2 passed / 0 failed |
| M3 | 两条用例的判定互换 |
| M4 | 丢掉错误信息 |
| M5 | 把错误信息改写成自己的措辞 |
| M6 | 计数对但逐条判定错 |
| M7 | 判定与夹具声明的期望不符 |
| M8 | 少报一条用例 |
| M9 | 多报一条 CLI 没跑的用例 |
| M10 | 总数报错 |

同时要求**未变异的诚实结果必须被接受**——否则一个「一律拒绝」的比较也能通过负控。

变异只作用于内存中的副本，**不触碰被测产品源码**。

## 4. 探针的执行方式

```
node tools/ats107-probes/st-ats107.mjs <repo> <scratch-dir>
```

- Bridge 起在**空闲端口**上（探针用 `net` 向操作系统要一个），不和开发者自己开着的实例抢默认端口；
- 夹具被**复制**到临时目录再安装、运行：Bridge 绝不在仓库工作树上跑，避免把 `test-results/` 写进源码树，也让运行的 `gitCommit` 指着一棵干净的树；
- 夹具用 `npm ci` 安装（不是 `npm install`），证明入库的 lockfile 可复现；
- 探针结束时杀**整棵进程树**（Windows 上 `taskkill /T /F`），因为 Bridge 会 spawn Playwright CLI 作为子进程。

## 5. 边界

- **本机没有真实 Chromium 时，探针报 SKIP 而不是 PASS**。验收口径说的是真实浏览器，没有浏览器的机器没有满足它。
- **引擎版本漂移会被记录在证据里**（探针打印实测版本），而不是被藏起来。
- **本项的覆盖面只有那两条离线用例**：真实站点的联网用例、可中断的长用例（ST-010）、多次重复执行（ST-012）仍未实测。

## 6. 相关文档

- `docs/26-RUNNER-PREFLIGHT.md` —— ATS-106 的运行前预检与参数安全基线（本项的前置）
- `docs/16-BASELINE-ADR.md` —— B-01 的成因与结论
- `docs/18-RUNNER-ADAPTER-CONTRACT.md` —— 运行器适配器契约
