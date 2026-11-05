# ATS-DD-018 Runner / Reporter アダプタ契約 v1（RunnerAdapter / ReporterAdapter 契約及び能力交渉）

- 文書 ID: ATS-DD-018
- 対応 WBS: ATS-301（S3 / v0.3.0 / 実行 / BE）
- 対応要件: FR-023（WDIO Tauri Runner）、FR-009 / FR-010 / FR-011 / FR-014（実行・停止・収集）
- 基準日: 2026-11-04
- 状態区分の 凡例: `IMPLEMENTED` = コード実装済みかつ実測証拠あり / `DESIGNED` = 設計のみで未実装 / `PARTIAL` = 一部のみ
- 本書の中心命題: **Bridge は「テストエンジン」ではなく「アダプタ」に talking する。** 各アダプタは事前に能力を宣言し、呼び出し側は「今このプロジェクトで X ができるか」を真偽で答えられる。

---

## 1. 目的と完了定義

ATS-301 の完了定義は次の 2 項目である。

| # | 完了定義 | 本書での該当箇所 | 状態 |
|---|---|---|---|
| AC-1 | Playwright と WDIO が同一の 発見 / 起動 / 停止 / 収集 API を通る | §4 契約 / §5 両エンジン実装 / §7 IT 証拠 | IMPLEMENTED |
| AC-2 | サポートされない能力を検出できる | §3 能力語彙 / §4.3 交渉 / §6 差分 | IMPLEMENTED |

本書は**設計が実装より先行する箇所を実装済みと称さない**。§9 に未実装・未実測の項目を明示する。

---

## 2. なぜこの契約が必要か（背景）

v0.1 の Bridge は Playwright Test CLI を直接起動していた。引数ベクタは手書きで、CLI の能力とは無関係に決められていた。

- **ATS-101 欠陥 B-01（実測で立証済み）**: 手書きの引数ベクタは `playwright test` が**持たない** 2 つのオプション（`--screenshot`, `--video`）を含んでいた。CLI はベクタ全体を拒否し、**実ブラウザ実行は 100% 引数解析フェーズで失敗**した（`summary=null`, `artifacts=[]`）。
- B-01 は「2 個のオプションを削る」ことでは閉じない。 存在を確認していないオプションが 1 つでも混ざれば同じ失敗が再発する。**唯一安全な方針は「推測しない」こと**——インストール済み CLI の `--help` が唯一の契約である。
- WDIO を追加すると問題はもう一桁増える。WDIO は flat な引数ベクタではなく**設定ファイル駆動**であり、reporter も設定ファイル内で指定する。よって「引数で引擎を差し替える」方式では成立しない。

したがって §2.1 の原則が契約の中心になる。

### 2.1 原則

| # | 原則 | 実装場所 |
|---|---|---|
| P-1 | **契約はデータであって振舞ではない。** `capabilities(project)` は直列化・差分比較・assert 可能な plain object を返す。能力が無いこと自体は例外ではなく `supported:false` + 理由として表現する。 | `server/adapters/contract.mjs` |
| P-2 | **宣言された能力は「証明」されたものだけ。** 「CLI にそのオプションがある」は証明ではない。「そのオプションが受理され、成果物が生成された」は証明である。`evidence` フィールドに証明方法を記録し、推定と実測を区別可能にする。 | 同上 `capability()` |
| P-3 | **Bridge に必要な操作は 4 つだけ。** `discover` / `start` / `stop` / `collect`。エンジン固有の概念はこの 4 つの背後だけに隠す。 | `REQUIRED_OPERATIONS` |
| P-4 | **サポート外は正常な報告可能な結果。** 例外でも silent no-op でもない。`requireCapability()` はアダプタ自身の理由を伴う `CAPABILITY_UNSUPPORTED` を送出し、API 層は 4xx に写像できる。 | `requireCapability()` |
| P-5 | **交渉（negotiation）には project が必須。** 能力はプロジェクト（インストール済み CLI・reporter・設定）の性質であるため、project なしに交渉するのは誰も問わなかった問いに答えることになる。 | `negotiate(adapter, project, requested)` |

---

## 3. 能力語彙（Capability Vocabulary）

すべてのアダプタは**ちょうどこの 14 個のキー**を宣言する。これにより Bridge はエンジンことを知らずにアダプタ同士を比較できる。

| 能力 | kind | 意味 |
|---|---|---|
| `discover` | required | プロジェクトのテストケースを列挙する |
| `start` | required | 実行を開始する |
| `stop` | required | 実行中の実行を停止する |
| `collect` | required | 実行の結果と証拠を収集する |
| `filterByFile` | optional | 1 ファイルに限定して実行する |
| `filterByTestUid` | optional | 識別された 1 ケースのみ実行する |
| `structuredReport` | optional | 機械可読な結果ファイルを作る |
| `htmlReport` | optional | HTML 形式の結果レポートを作る |
| `trace` | optional | 実行のトレースを作る |
| `screenshot` | optional | スクリーンショットを作る |
| `video` | optional | 動画記録を作る |
| `cancel` | optional | 進行中の実行を停止する |
| `nativeBrowser` | optional | 実ブラウザを駆動する（スタブではない） |
| `cliContract` | diagnostic | インストール済み CLI がアダプタが渡す引数ベクタを受け付ける |

`kind` の意味:

- `required`: なしではアダプタが機能しない
- `optional`: なくても機能はするが、呼び出し側が欲しがるかもしれない
- `diagnostic`: エンジン自身の契約に関する事実。既知の不具合を「踏んでから知る」のではなく「先に知る」ために報告する

### 3.1 能力エントリの形

```javascript
{
  name: 'trace',
  kind: 'optional',
  supported: true,
  reason: '',                                  // supported=false のとき必須
  evidence: 'the installed CLI accepts --trace (probed from --help); the measured run wrote trace.zip per test under the --output directory',
  detail: { options: [...], passed: [...] },  // アダプタ固有の事実
}
```

**`supported:false` に `reason` が無い状態は生成できない**（`capability()` が `CAPABILITY_REASON_REQUIRED` で拒否する）。
**`supported:true` に `evidence` が無い状態も生成できない**（`CAPABILITY_EVIDENCE_REQUIRED` で拒否する）。
この 2 つの制約が P-2 を機械的に強制する。

---

## 4. 契約（Contract）

### 4.1 アダプタの形状

```javascript
{
  kind: 'playwright',              // 不透明な識別子。Bridge はこれ以上解釈しない
  contractVersion: 1,              // ADAPTER_CONTRACT_VERSION と一致すること
  capabilities(project) -> Cap[],  // プロジェクトごとの能力行列
  discover(project) -> { tests, files, warning, runner },
  start({project, run, file, outputDir}) -> { child, pid, command, args, ... },
  stop(handle),
  collect({outputDir}) -> { summary, ... } | null,
}
```

`assertAdapter()` が登録時に形を検証する（欠落 operation / バージョン不一致は登録時に落ちる）。

### 4.2 能力行列はプロジェクトごとに計算する

`capabilities(project)` の引数は**プロジェクト**であり、エンジン種別ではない。理由:

- Playwright の `screenshot` / `video` は CLI オプションではなく**プロジェクト自身**の `use:{}` 設定の性質である（§8.2）。
- WDIO の `nativeBrowser` はプロジェクトに WebDriver バイナリがあるかどうかに依存する。
- 同じエンジンでも、能力はプロジェクトごとに違う。能力行列をプロジェクト粒度で返すのはこのため。

### 4.3 交渉（Negotiation）

```javascript
negotiate(adapter, project, requested) -> {
  adapter, contractVersion, requested,
  supported,      // requested の全件が supported なら true
  missing,        // 不足分。各要素にアダプタ自身の reason を含む
  capabilities,   // プロジェクト全体の能力一覧
}
```

- `missing` の各要素は `name` / `kind` / `supported` / `reason` / `evidence` / `detail` を持つ。**呼び出し側は独自の理由を作らず、この reason をそのままユーザーに出せる。**
- アダプタが宣言していない能力を要求された場合は `kind:'unknown'` の要素が `missing` に入る（例外ではない）。
- `requireCapability()` は `supported:false` の場合に `AdapterError('CAPABILITY_UNSUPPORTED')` を投げる。`details.missing` に全理由が入っている。

### 4.4 選択（Selection）

| 関数 | 挙動 |
|---|---|
| `selectAdapter(project, requested, {preferred})` | requested を満たす最初のアダプタを返す。満たすものが無ければ `NO_RUNNER_SUPPORTS_REQUEST` を投げ、`details.rejected` に**全アダプタの拒否理由**を載せる。 |
| `selectAdapterOrThrow(project, requested, {preferred})` | `preferred` 指定時は**フォールバックしない**。指定エンジンで要求を満たせなければ `CAPABILITY_UNSUPPORTED`。 |

**`preferred` でフォールバックしないのは意図的な設計である。** 自動選択なら別のエンジンへ代替するのが正しいが、呼び出し側が明示的にエンジンを選んだ場合、勝手に別のエンジンを走らせるのは「頼 않은ものを実行する」ことに等しい。

---

## 5. 2 エンジンの実装

### 5.1 共通結果モデル

両エンジンは**同一のモデル**へ写像される。

| フィールド | 意味 |
|---|---|
| `summary.total` / `passed` / `failed` / `skipped` / `flaky` | 集計 |
| `summary.cases[]` | `title` / `file` / `status` / `duration` / `error` |
| `summary.browser` | 実ブラウザの名称とバージョン（WDIO 側） |
| `summary.unattributedCases` | 所属ファイルを特定できなかったケース数（WDIO 側） |

status の写像:

| エンジン | 生 status | → 共通 status |
|---|---|---|
| Playwright | `expected` | `passed` |
| Playwright | `unexpected` | `failed` |
| Playwright | `flaky` | `flaky` |
| Playwright | `skipped` | `skipped` |
| Playwright | その他 | `unknown` |
| WDIO | `passed` | `passed` |
| WDIO | `failed` | `failed` |
| WDIO | `skipped` / `pending` | `skipped` |
| WDIO | その他 | `unknown` |

写像は `server/adapters/playwright-cli.mjs` の `mapPlaywrightStatus()` と `server/adapters/wdio.mjs` の `mapWdioStatus()`。**集計値は写像後の status から再計算する**ので、集計と個別ケースの status が食い違う余地がない。

### 5.2 Playwright アダプタ

- 実装: `server/adapters/playwright.mjs`
- 共通ロジック: `server/adapters/playwright-cli.mjs`（`core.mjs` の `safeRunArgs()` と同じ実装を使う。**引数ベクタの決定は製品コードの中に 1 箇所しか無い**ようにするため）

実測事実（`@playwright/test` 1.64.1、本機実測。証拠は `docs/evidence/ATS-301/01-playwright-ground-truth.log`）:

| 事実 | 証拠 |
|---|---|
| `playwright test --help` は `--reporter` / `--output` / `--trace` / `--workers` / `--grep` / `--project` / `--list` を受け付ける | 解析したオプション 42 個に実在 |
| `--screenshot` / `--video` は**存在しない** | 42 個に含まれない |
| テストファイルは**位置引数**（`[test-filter...]`）でありオプションではない | usage 行の実測 |
| JSON report は `PLAYWRIGHT_JSON_OUTPUT_FILE` 経由で `{config, suites, errors, stats}` の形で届く | 実 report.json の構造 |
| 失敗 1 件の run の終了コードは 1 | 実測 |

引数ベクタの構築規則（B-01 の再発防止）:

```
[cli, 'test']
  + --reporter=line,json,html   (help が --reporter を宣言している場合のみ)
  + --output <runDir>/results    (同上)
  + --trace on                   (同上)
  + --workers 1                  (同上)
  + [testFile]                   (位置引数)
```

`--help` が読めなかった場合のみ、产品が従来使ってきた最小ベクタ（`reporter`/`output`/`trace`/`workers`）に**フォールバック**する。これは「引数を渡さないことによる挙動変化」（成果物・レポートの消失）を避けるための保守的選択であり、**能力の主張には影響しない**（§8.1）。

### 5.3 WebdriverIO アダプタ

- 実装: `server/adapters/wdio.mjs`

WDIO は**設定ファイル駆動**である。flat な引数ベクタでエンジン固有の knob を渡せないため、アダプタは**実行ごとに一時的な `wdio.conf.js` を run の出力ディレクトリに生成**し、プロジェクトの `wdio.conf.*` を base として自分の設定を上に載せる。**プロジェクト本体には一切書かない。**

実測事実（`@wdio/cli` 10.1.0 + 実 Chrome 151、本機実測。証拠は `docs/evidence/ATS-301/02-wdio-ground-truth.log`）:

| 事実 | 証拠 |
|---|---|
| json reporter は**ワーカーごとに 1 ファイル** `wdio-<cid>-json-reporter.json` を reporter の `outputDir` に書く | 実測で 2 ファイル生成 |
| `outputFile` はこの reporter バージョンでは**効かない**（stdout に出る） | 実測 |
| ResultSet は `{start, end, capabilities, framework, mochaOpts, suites, specs, state}` | 実測 |
| **suite には `file` フィールドが無い**。`specs` は**オブジェクト配列ではなく URL 文字列配列** | 実測 |
| 失敗した test は `error` オブジェクト（`name`/`message`/`stack`/`type`）を持つ | 実測 |
| 失敗 1 件の run の終了コードは 1 | 実測 |

この結果から 2 つの実装上の帰結がある。

1. **複数ワーカーの ResultSet は必ず merge する。** 最後のワーカーだけを見ると集計が過少になる。`mergeWdioReports()` が全ファイルを統合する。
2. **ケースの所属ファイルは推測しない。** ワーカーの `specs` が 1 件だけならそのパスに割当てるが、複数なら**空欄**にし `unattributedCases` で数える（`fileUrlToRelative()` / `mergeWdioReports()`）。

生成 config の 2 つの実装上の注意（いずれも実測で発見した不具合）:

- WDIO の config は `exports.config = {...}` なので `require()` は `{config:{...}}` を返す。`base.config` として読む必要がある。**`base` を二重に宣言すると生成ファイルが構文エラーになり、テストが 1 件も走る前に失敗する。**
- WDIO は spec パスを**config ファイルのディレクトリ基準**で解決する。生成 config は run の出力ディレクトリに置くため、プロジェクトの相対 spec パス（`./tests/pass.spec.js`）は解決できない。**base の specs を絶対パスへ書き換える。**

---

## 6. 2 エンジンの能力差分（同一プロジェクトに対して）

`GET /api/projects/:id/runners` はこの差分を返す。

| 能力 | Playwright | WebdriverIO | 理由（実測に基づく） |
|---|---|---|---|
| `discover` | ✅ | ✅ | PW は静的索引、WDIO は拡張子スキャン |
| `start` / `stop` / `collect` / `cancel` | ✅ | ✅ | いずれも子プロセスを保持して kill できる |
| `filterByFile` | ✅（位置引数） | ✅（`--spec` / config の `specs`） | |
| `filterByTestUid` | ❌ | ❌ | 安定 UID は FR-021 / ATS-307 范畴で未実装 |
| `structuredReport` | ✅ | ✅ | PW=JSON reporter、WDIO=json reporter |
| `htmlReport` | ✅ | ❌ | **WDIO に HTML reporter パッケージは存在しない**（`@wdio/html-reporter` は npm 404）。WDIO の reporter は JSON/JUnit/text を出力する |
| `trace` | ✅ | ❌ | WDIO に trace 相当の内蔵成果物なし（ATS-302 范畴） |
| `screenshot` | プロジェクト依存 | ❌ | PW の CLI に `--screenshot` は無い。**プロジェクトの `use.screenshot` 設定の有無で決まる** |
| `video` | プロジェクト依存 | ❌ | 同上（`use.video`） |
| `nativeBrowser` | ✅ | 環境依存 | WDIO は WebDriver バイナリ（`CHROMEDRIVER_PATH` / プロジェクト `node_modules/.bin` / WDIO キャッシュ）が必要 |

**この表は「WDIO の方が劣っている」ではなく「両エンジンの差異を明示的にした」 Capability Matrix である。** 呼び出し側は `GET /runners` でこの表を取得し、UI で利用者に見せられる。

---

## 7. API 面

| エンドポイント | メソッド | 内容 |
|---|---|---|
| `/api/projects/:id/runners` | GET | 全アダプタ分の能力行列（プロジェクト単位） |
| `/api/projects/:id/runners` | POST | 能力指定での選択。`{capabilities:[...], runner?}` → 選択結果 / 拒否理由 |
| `/api/projects/:id/run` | POST | 実行。`{file?, capabilities?, runner?}`。既定は `['discover','start','stop','collect']` |

エラー码（`docs/04-DETAILED-DESIGN.md` §7 の既存体系に準拠）:

| 码 | HTTP | 意味 |
|---|---|---|
| `CAPABILITY_UNSUPPORTED` | 409 | 指定された runner が要求を満たせない（`preferred` 指定時のフォールバック禁止） |
| `NO_RUNNER_SUPPORTS_REQUEST` | 409 | どの runner も要求を満たせない |
| `UNKNOWN_RUNNER` | 404 | 未知の runner 名 |
| `CAPABILITIES_NOT_AN_ARRAY` | 400 | `capabilities` が配列でない（黙って空要求にしない） |

**409 のレスポンスには理由が伴う。** `error` コードだけでは呼び出し側に「何が足りなかったのか」が伝わらないので、409 のボディは失敗した要求の理由を持つ:

```json
{
  "error": "NO_RUNNER_SUPPORTS_REQUEST",
  "missing": [ { "name": "filterByFile", "kind": "capability", "reason": "..." } ],
  "rejected": [ { "kind": "playwright", "missing": [ { "name": "...", "kind": "...", "reason": "..." } ] } ]
}
```

- `missing[]` — 要求された capability のうち満たせなかったもの。`name` / `kind` / `reason`（アダプタが返した説明）を運ぶ。`runner` 指定で落ちた場合は `runner` も付く。
- `rejected[]` — 順に試した runner ごとの理由。どの runner がなぜ落ちたかを区別したい場合に見る。

`reason` は**アダプタが返した文言をそのまま**運ぶ（ Bridge 側で文言を作り直さない）。

**既定の `/run` は v0.1 の契約を保つ。**  要求が明示されていない既定呼び出しでは、202 を返し `status='error'` と理由（エンジン未インストール等）で**明示的に失敗**する（`docs/04-DETAILED-DESIGN.md` §7 の `PLAYWRIGHT_NOT_INSTALLED...` 相当）。一方、**明示的な能力要求**が交渉（negotiation）失敗した場合は 409 と理由を返す（500 ではない）。

**`runner` を指定した呼び出しはフォールバックしない。** 別のエンジンを勝手に走らせると、呼び出し側が要求していないエンジンを実行することになるため、その runner で満たせない場合は 409 を返す。

**`capabilities` が配列でない場合は 400。** 黙って空の要求（=全 capability 相当）に落とすと、要求したつもりではないものが走る。

---

## 8. 「証明済み」を定義する（境界の置き場所）

### 8.1 能力の証明と実运行の分離

- **能力（capability）**: 「このプロジェクトでこの操作は可能である」。証明方法は `evidence` に記録する。
- **実行（run）**: 実際にエンジンで走らせた結果。

この 2 つは**同じものではない**。特に:

- `--help` が読めなかったとき、アダプタは**最小ベクタで実行できる**が、「CLI がオプションを宣言している」ことは**証明できていない**。よって `cliContract` / `structuredReport` / `htmlReport` / `trace` は `supported:false` のままで、reason に「help を解析できなかった」と書く。**実行はできても、能力を主張しない。**

### 8.2 スクリーンショット / ビデオはプロジェクト性質である

Playwright CLI には `--screenshot` / `--video` が無い。これらは `playwright.config.ts` の `use:{}` ブロックの項目である。よって:

- `screenshot` / `video` の能力は**プロジェクトの設定ファイルを読む**ことで判定する。
- プロジェクトが `use.screenshot` を宣言していないなら、その機能は「CLI が無いから」ではなく「**プロジェクトが設定していないから**」が reason になる。設定の注入は ATS-106 のスコープ。

---

## 9. 未実装・未実測（正直な Declarations）

### 9.0 Bridge 側の経路の正確な範囲

**Bridge が契約メソッドを呼ぶのは `start` と `collect` だけである。** `discover` と `stop` は v0.1 の経路のまま:

| 操作 | Bridge の経路 | 契約か否か |
|---|---|---|
| discover | `GET /api/projects/:id/tests` → `discoverStatic()`（`server/core.mjs`） | **契約ではない**（v0.1 経路） |
| start | `adapter.start({project, run, file, outputDir})` | 契約 |
| stop | `POST /api/runs/:id/stop` → `cancelRun()` が `taskkill` を inline 実行（`server/index.mjs`） | **契約ではない**（v0.1 経路） |
| collect | `adapter.collect({outputDir})` | 契約 |

したがって**「Bridge 側 只调用契约方法」という主張は成り立たない**。アダプタ層（`server/adapters/*`）だけが 4 操作を契約として実装しており、HTTP 層はそのうち 2 つしか契約を通していない。`discover` / `stop` を契約へ寄せる作業は Bridge 経路の差し替えを伴い本項のスコープ外なので、§9 に明記する。

#### 9.0.1 プロジェクトの登録条件（WDIO のみ的项目は登録できない）

**Bridge にプロジェクトを登録する API は、Playwright の設定ファイルを要求する。** `validateProjectPath()`（`server/core.mjs`）は `package.json` に加えて `playwright.config.[cm]?[jt]s` の存在を要求し、無ければ `PLAYWRIGHT_CONFIG_REQUIRED` を投げる。

| 登録するプロジェクト | 登録結果 |
|---|---|
| Playwright プロジェクト（`playwright.config.*` あり） | 登録できる |
| **WDIO のみ的项目**（`wdio.conf.*` あり、`playwright.config.*` なし） | **`PLAYWRIGHT_CONFIG_REQUIRED` で登録できない** |

そのため §6 と §7 の「WDIO と PW は同一プロジェクトの runner である」という記述は、**Bridge の HTTP 経路では、WDIO を明示指定した呼び出しが到達できるプロジェクトに限定して**成り立つ。`GET /api/projects/:id/runners` と `POST /api/projects/:id/run {runner:'wdio'}` は、`playwright.config.*` を持つプロジェクトに対してのみ WDIO runner を選べる。WDIO だけを持つプロジェクトは Bridge 側に登録の入口がない。

**この制約は v0.1 の登録要件（Playwright プロジェクト前提）に由来するもので、アダプタ契約の制限ではない。** WDIO のみ的项目の受付は登録条件の緩和を要する別件であり、本項のスコープ外である。§9.1 に「未実装」として明記する。

### 9.1 未実装・未実測の一覧

| 項目 | 状態 | 理由 / 担当 |
|---|---|---|
| WDIO のみ的プロジェクトの登録 | 未実装 | 登録 API が `playwright.config.*` を要求するため、WDIO のみのプロジェクトは `PLAYWRIGHT_CONFIG_REQUIRED` で登録できない（§9.0.1）。登録条件の緩和は本項のスコープ外 |
| `filterByTestUid`（両エンジン） | DESIGNED | 安定 UID 仕様は FR-021 / ATS-307（別 WBS） |
| WDIO の `htmlReport` | DESIGNED（かつ不可能） | `@wdio/html-reporter` パッケージが存在しない。WDIO 側で HTML を作るなら自前実装が必要（ATS-302 范畴） |
| WDIO の `trace` / `screenshot` / `video` | DESIGNED | ATS-302（WDIO Tauri Service / Runner 原型）范畴 |
| WDIO の `nativeBrowser` が false の環境 | 実装済（理由付き） | WebDriver バイナリが無い環境では `reason` 付きで false を返す |
| Playwright の `screenshot` / `video` が false | 実装済（理由付き） | プロジェクトが `use.screenshot` / `use.video` を宣言していない |
| 複数 spec を 1 ワーカーで走らせた場合の WDIO ケース→ファイル割当 | 部分 | reporter が suite に file を持たないため、空欄＋`unattributedCases` で表現する |
| macOS / Linux での実測 | 未実測 | 本机和は Windows 11 のみ。CI は Windows |
| 複数ワーカー（`maxInstances>1`）での WDIO 統合 | 実測済（2 ワーカー） | fixture は `maxInstances:1` だが、実測では 2 ワーカーが生成された（spec ごとにワーカー） |
| `capabilities()` の同期プローブとキャッシュ | 実装済（既知の弱点） | `spawnSync` による同期プローブでキャッシュが無い。実測で PW 約 0.5s / WDIO 約 1.1s。Bridge のイベントループをブロックする。`GET /runners` の実測応答は約 824ms |
| `stop` / `cancel` / `discover` / `nativeBrowser` の `evidence` | 静的文言 | これらの evidence 文言は**この場で測定した事実ではなく**、実装に基づく説明である。§4 ルール 2（証明されたものだけを supported:true にする）の観点では、`cliContract` / `structuredReport` / `filterByFile` のように実測で裏付けられたものと区別して読むこと |

---

## 10. 関連文書

| 文書 | 関係 |
|---|---|
| `docs/02-REQUIREMENTS.md` | FR-023（WDIO Tauri Runner）、FR-009/010/011/014 |
| `docs/04-DETAILED-DESIGN.md` §3/§4/§7 | 状態機械、Playwright 実行命令、エラー码 |
| `docs/16-BASELINE-ADR.md` §4 B-01 | 本契約が存在する理由（引数ベクタの推測禁止） |
| `docs/07-UT-TEST-DESIGN.md` / `docs/08-IT-TEST-DESIGN.md` | 本書の UT/IT 該当範囲 |
| `docs/evidence/ATS-301/` | 実測ログ（下表） |
| `tools/ats301-probes/` | 再現スクリプト（ground truth / repeat / debug） |
| `server/adapters/` | 実装（contract / playwright / playwright-cli / wdio / registry） |
| `tests/adapters.test.mjs` / `tests/adapters-engines.test.mjs` / `tests/adapters-it.test.mjs` | UT / UT(エンジン) / IT |
| `tests/api.test.mjs` | HTTP 層（capability 协商 / 409 の理由 / 400） |

### 10.1 実測ログの一覧（`docs/evidence/ATS-301/`）

| ファイル | 何の証拠か | 再現コマンド |
|---|---|---|
| `00-npm-test-full.log` | 全量テスト 189/189 pass | `npm test` |
| `01-playwright-ground-truth.log` | 実 Playwright（`@playwright/test` 1.64.1）での ground truth | `node tools/ats301-probes/playwright-ground-truth.mjs` |
| `02-wdio-ground-truth.log` | 実 WebdriverIO 10.1.0 での ground truth | `node tools/ats301-probes/wdio-ground-truth.mjs` |
| `03-adr-citations.log` | ADR の全 `path:line` 引用が解決し、fix script が冪等であることの実測 | `PYTHONUTF8=1 python tools/check_adr_citations.py` |
| `04-stop-noop-mutation.log` | `stop()` の no-op 変異で stop の IT が赤くなる（assertion が恒真でない）ことの実測 | `node --test tests/adapters-it.test.mjs` |
| `05-http-409-reason-mutation.log` | 409 の理由生成を潰すと HTTP IT が赤くなることの実測 | `node --test tests/api.test.mjs` |
| `06-wbs-updaters-gate.log` | 全 updater（ATS-301 を含む）の冪等性の実測 | `bash tools/ats501-probes/check-wbs-updaters.sh` |
| `07-ats301-gate.log` | 門禁（WBS 回帰 + ADR 引用 + ポート監査）の実測 | `bash tools/ats301-probes/check-ats301-gate.sh` |
| `08-wbs-xml-escaping.log` | WBS updater の XML エスケープが必要であることの実測 | `bash tools/ats401-probes/collect-evidence.sh`（`09-wbs-xml-escape.log`） |
| `09-filterbyfile-c1.log` | C1（Playwright の位置引数フィルタ）が本物であることの実測 | `bash tools/ats401-probes/collect-evidence.sh`（`05-review-regressions.log`） |
| `10-port-audit.log` | ATS-101 シナリオ D のハードコードポート監査の実測 | `node tools/ats101-probes/scenario-d-port-audit.mjs` |
| `11-wbs-ats301-note.log` | 合併後の工作簿における ATS-301 行の実テキストと updater の出力の比対 | `PYTHONUTF8=1 python tools/ats301-probes/show-ats301-note.py` |

### 10.2 門禁

```
bash tools/ats301-probes/check-ats301-gate.sh
# あるいは
npm run gate:ats301
```

WBS の共有セル回帰テスト（`tools/test_wbs_common.py`）、ADR 引用チェック（`tools/check_adr_citations.py`）、および ATS-101 のハードコードポート監査（`tools/ats101-probes/scenario-d-port-audit.mjs`）をまとめて走らせる。

**ポート監査を門禁に含める理由**：ATS-301 の納品で「ポート番号を含むソースファイル」を追加したことで ATS-101 のポート監査が赤くなったが、ポート監査を走らせていない門禁ではこの型の回帰を検出できない。門禁が通ってもポート監査が落ちるという状態を作り出さないため、監査を門禁の一部として組み込む。

この門禁は CI（`.github/workflows/ats-102-build.yml`）でも `npm run gate:ats301` として走る。

スクリプト自身が `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` を設定し、解釈系と stdout エンコーディングを evidence に記録する
（既定の Windows コンソールは stdout が ANSI コードページ (gbk/cp936) になり、中国語を含む出力が壊れる）。
