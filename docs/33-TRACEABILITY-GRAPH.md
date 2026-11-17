# ATS-DD-033 语义图谱 Schema（ATS-307｜S3 / v0.3.0｜图谱）

- 文書 ID: ATS-DD-033
- 対応 WBS: ATS-307（S3 / v0.3.0 / 图谱 / BE）
- 対応要件: FR-026（Requirement→Script→Run→Evidence 可查询和影响分析）
- 基準日: 2026-11-17
- 状態区分の凡例: `IMPLEMENTED` = コード実装済みかつ実測証拠あり / `DESIGNED` = 設計のみで未実装 / `PARTIAL` = 一部のみ
- 本書の中心命題: **追跡とは「行列」ではなく「有向非巡回グラフ」である。** 行列は
  「要件にどのテストが紐づくか」にしか答えられない。グラフは両方向 walks でき、
  欠けた環を**見える形で**報告する。

---

## 1. 目的と完了定義

ATS-307 の完了定義は次の 3 項目である。

| # | 完了定義 | 本書での該当箇所 | 状態 |
|---|---|---|---|
| AC-1 | ノード/辺に安定した UID がある | §4 UID 規約 / `server/traceability/model.mjs` | IMPLEMENTED |
| AC-2 | ノード/辺に**出所**がある | §5 出所（provenance） / `EDGE_TYPE`・`PROVENANCE` | IMPLEMENTED |
| AC-3 | ノード/辺に **Git commit** がある | §6 由来と commit | IMPLEMENTED |
| AC-4 | 循環辺が検査できる | §7.1 孤児辺・循環の検査 | IMPLEMENTED |
| AC-5 | 孤児辺が検査できる | §7.1 孤児辺・循環の検査 | IMPLEMENTED |

本書は**設計が実装より先行する箇所を実装済みと称さない**。§9 に未実装・未実測の項目を明示する。

---

## 2. なぜ既存（`tests/rtm.json`）では足りなかったか

リポジトリには既に追跡**行列**がある。`tests/rtm.json`（生成物）と
`docs/10-RTM.md`（人読版）は、要件ごとに「設計アンカー」と「テスト ID 列表」を
持つ。49 行、要件 ID 49 個、テスト参照 1069 本。

その行列が答えられない問いが 3 つある。

1. **逆引きができません。**「このテストはどの要件を検証するか」を
   行列は表の行方向でしか答えられない。`FR-021` の行は 91 本のテスト ID を
   持っているので、`UT-DSC-001` がどの行にあるかは機械では読めず、
   人は grep で探すしかない。
2. **欠けた環が文字列です。**`FR-022` のテスト欄は `TBD` という**文字列**で
   ある。これは「そのテスト ID が存在しない的意思」ではなく、「まだ決めていない
   という意味」であり、プログラムは両者を区別できない。`tests/rtm.json` の
   `tests` 欄は `、` 区切りの**平坦な文字列**であり、欠落した環は構造上表現できない。
3. **出所がありません。**「UT-DSC-001 が `tests/discovery.test.mjs` に実在するか」
   は、行列からは分からない。行列は *主張* の器であって、*事実* の器ではない。

---

## 3. ノード 6 種と辺 5 種

### 3.1 ノード

| 種 | 実体 | キー | 出所 |
|---|---|---|---|
| `requirement` | 要件 | 要件 ID（`FR-001`） | `tests/rtm.json` / `docs/02-REQUIREMENTS.md` |
| `design` | 設計アンカー | `B01` / `UI-007` / `UC-01` / `P1 Graph` | `docs/03-BASIC-DESIGN.md`・`docs/05-UI-UX.md`・`docs/02-REQUIREMENTS.md` |
| `testcase` | テストケース | テスト ID（`UT-CORE-001`） | `tests/test-cases.json` |
| `script` | 実装スクリプト | ファイルパス（`tests/core.test.mjs`） | ツリーの `test(...)` 宣言 / カタログの `evidence` 欄 |
| `run` | 実行 | run UID / トランスクリプトのパス | `state.json.runs[]` / `docs/evidence/**/*.log` |
| `evidence` | 証拠 | `<runId>/<file>` / `transcript:<path>` | `state.json.runs[].artifacts` / トランスクリプト |

各ノードは `present` を持つ。**`present: false` のノードは消されない。**
カタログが言及しているのに実体が無いものは消すと欠落が隠れるため、
消さずに「存在するが実体は無い」として残す。

### 3.2 辺

| 辺 | 意味 | 出所 |
|---|---|---|
| `designs` | 要件が設計アンカーを名指す | `catalog` |
| `covers` | 設計アンカーがテストケースを覆う | `catalog` |
| `implemented` | テストケースを実装するスクリプト | `source`（宣言）／`catalog`（カタログの `evidence` 欄） |
| `attempted` | テストケースを実行した run | `runtime`（`state.json`）／`evidence`（トランスクリプト） |
| `archived` | run がアーカイブした証拠 | `runtime` / `evidence` |

### 3.3 グラフは DAG。反向辺は**持たない**

すべての辺は**低い hop から高い hop へ**流れる。

```
requirement(0) -> design(1) -> testcase(2) -> script(3)
                                    |              |
                                    +-> run(4) ---+-> evidence(5)
```

`evidence -> testcase` のような**逆向きの辺は持たない**。理由は 2 つ。

* 逆辺を持てば `evidence -> testcase -> run -> evidence` の**循環**が生まれ、
  「循環辺が検査できる」という完了定義 (§1 AC-4) が無意味になる。自作した
  モデルが自分の検査を壊すことになる。
* 逆辺は情報を**重複**する。`(evidence, testcase)` の組は
  「その証拠をアーカイブした run」と「その run が試行したケース」から既に
  導出できる。

したがって**逆引きは保存された辺の逆走査**として計算する
（`server/traceability/query.mjs` の `traceEvidence()`）。

### 3.4 共有ノードの結合は**辺**に持つ

設計アンカーは要件間で**共有**される。`B04` は FR-007・FR-008・FR-009 の
設計である。したがって「テストケース -> 設計 -> 要件」をたどると、
`UT-E-001` について `B04` を使う**全ての**要件に到達してしまう。

RTM の真実は**行単位**である。FR-007 は `UT-E-001` を、FR-008 は `UT-E-002` を
列挙する（両者とも `B04` の下にあるdespite）。だから結合は `covers` **辺**に
`requirement` として持たせる。辺的行が RTM の行であり、辺がその行の真值的
所在である。逆走査はこの辺の結合を読む。

（この結合の付け忘れは、実装中のプローブで実際にバグとして検出した。
`traceEvidence()` が FR-007 の証拠から FR-008 まで到達していた。）

---

## 4. UID 規約

ノード UID は `trc_1_<24 hex>`、辺 UID は `tre_1_<24 hex>`。
`docs/18-UID-SPEC.md` の Run / Attempt と同じ方式族（`run_1_<24 hex>`）なので、
追跡图が第二の識別方言を持ち込まない。

* **ノード**：`sha256(kind \0 key)` の先頭 24 hex。
* **辺**：`sha256(from \0 to \0 type)` の先頭 24 hex。

**基準はノード自身の kind と key だけ**であり、配列内の位置でも counter でも
ない。だから

* ノードを挿入しても他のノードの UID は変わらない；
* 同じツリーの別チェックアウトでも同じ UID になるので、commit をまたいで
  グラフを差分できる。

生成は純関数である（時計・乱数・ファイルシステム順のいずれも使わない）。

### 4.1 ノードの `kind` と `uid` は data で上書きできない

`makeNode()` は data Spread の**前**に `kind` と `uid` を置く。呼び出し側が
`kind: 'script'` を渡してもノードは requirement のままである。chain は kind で
組まれるので、上書きできるノードは要件 hop にスクリプトを潜り込ませられる。

---

## 5. 出所（provenance）

`catalog` / `source` / `runtime` / `evidence` の 4 種。

| 出所 | 意味 |
|---|---|
| `catalog` | 生成された RTM / テストカタログが**主張**している |
| `source` | ツリーのスクリプト自身が**宣言**している |
| `runtime` | ローカル state の run 記録 / manifest が**記録**している |
| `evidence` | `docs/evidence/` のトランスクリプトが**観測**している |

**主張と観測は違う。** カタログが `UT-CORE-001` に `PASS` と書くのは主張で、
その ID がスクリプトに実在するか、あるいはトランスクリプトに印字されたかが
観測である。グラフは両方を別々に記録する。

### 5.1 宣言が 2 種ある：`source` と `catalog`

`implemented` 辺には 2 段階の確度がある。

* `source`（強い）：スクリプト自身がそのケース ID を宣言している
  （`test('UT-CORE-001: ...')`）。
* `catalog`（弱い）：カタログの `evidence` 欄がそのスクリプトを名指す
  （`node tools/ats107-probes/st-ats107.mjs`）。ST プローブは**シナリオ**を
  検査するので、ソースにケース ID を持たない。この場合 ID からスクリプト
  への結合はカタログ経由でしか作れない。

この差は `no-declaration` gap として**露出**する（§7.2）。

---

## 6. 由来と commit

各ノードは `source`（その事実の由来ファイル）を持つ。

* requirement / testcase -> `tests/rtm.json` / `tests/test-cases.json`
* design -> 定義する文書（`docs/03-BASIC-DESIGN.md` 等）
* script -> スクリプトのパス
* run（runtime） -> `state.json.runs[]`。run 記録は `gitCommit` を持つ
* run（transcript） -> トランスクリプトのパス
* evidence -> 証拠ファイルのパス。`sha256` は run の artifact なら manifest
  （ATS-209）の値、トランスクリプトなら「トランスクリプト自身には digest が
  無い」ことを明示する。

**Git commit を持たないノードがある。** トランスクリプトDerived の run/evidence
は、そのトランスクリプトが**どの commit で取得されたか**を記録していない。
実行時の run 記録は `gitCommit` を持つ。両者を同じ栏に押し込むのではなく
`subKind` で区別する（`transcript` / `runtime`）。

---

## 7. 検査

### 7.1 孤児辺と循環

* **孤児辺**：両端のノードがグラフに存在しない辺。
* **循環**：有向閉路。実装は 3 色 DFS（白/灰/黒）**. 灰** の隣接頂点が
  back edge、つまり循環。
* **present でないノード**：カタログが言及するが実体が無いもの。

実測（`docs/evidence/ATS-307/`）：**孤児辺 0、循環 0、present でないノード 0**。

検査が意味を持つかどうかは、**検査が失敗できる**ことで確認する。
`UT-ATS307-021` は意図的に循環を持つグラフを作り、検出することを求める。

### 7.2 gap の語彙

| gap | 意味 |
|---|---|
| `no-design` | 要件が設計アンカーを名指さない |
| `no-testcase` | 要件にテストケースが無い（RTM の `TBD`） |
| `no-script` | テストケースを実装するスクリプトが無い |
| `no-declaration` | スクリプトはカタログ経由でしか繋がらない（宣言が無い） |
| `no-run` | 一度も実行されていない |
| `no-evidence` | 実行が証拠を残していない |
| `dangling-test` | RTM が名指すテスト ID をカタログが持たない |
| `dangling-anchor` | RTM が名指す設計アンカーをどの文書も定義しない |

**gap は埋めない。** 欠けた環に見せかけのノードを挿入することは、
図から欠落を隠すこと Worse である。gap は名前と理由を持って報告される。

`no-script` と `no-declaration` を分けたのは重要である。`no-script` は
「実装が無い」であり、`no-declaration` は「実装は在るが、そのリンクを
ソース自身からは確認できない」であり、同一視すると実在する実装を
「無い」と報告することになる。

### 7.3 整合性検査

| 検査 | 意味 |
|---|---|
| `danglingTest` | RTM のテスト ID がカタログに無い |
| `danglingAnchor` | RTM の設計アンカーをどの文書も定義しない |
| `orphanEdge` | 端のノードが無い辺 |
| `caseWithoutScript` | スクリプトを実装しないケース（**gap** であり不一致ではない） |
| `falsePass` | カタログが `PASS` と宣言するがスクリプトが無い**偽の主張** |

`falsePass` だけが `ok` を壊す。`PENDING` のケースにスクリプトが無いのは
正直な gap であり、不一致ではない。

**設計アンカーの「段階標識」は不一致ではない。** `P1 Graph` は文書節を
名指すものではなく「この要件は P1 に計画されている」という**道程**である。
`NFR / SEC / OPS` も 3 つのアンカーではなく 1 つの**領域**である。
だから分割規則は「whole を先に試し、whole がアンカーとして既知でない時だけ
`/` で split する」であり、`P1 AST/CLI` から `CLI` を**|**|切り出さない。

---

## 8. 両方向の walk

### 8.1 前向き（要件 -> 証拠）

`traceRequirement(view, 'FR-015')` は返す：

* `chain`：6 hop それぞれに到達したノード
* `gaps`：欠けた hop と、その理由
* `coverage`：`verified` / `failed` / `executed` / `implemented` / `designed` /
  `uncovered`
* `cases`：ケースごとの script / run / evidence

#### `coverage` は「何が成立したか」である

coverage の 6 状態は**深さの順**であり、「何が成立したか」の順でもある。
`verified` と `failed` の差は**深さではなく結果**である：どちらも run に
到達し、証拠も残っている（= チェーンはそこまで到達した）が、
`verified` は**通った**実行の証拠、`failed` は**落ちた**実行の証拠である。

**WHAT RAN and WHAT WAS DECLARED PASS are two different facts.**
「実行された」と「PASS と宣言された」は別の事実であり、
coverage は両方を区別する：

| 実行の結果 | coverage |
|---|---|
| 一度も通らなかった（落ちた実行が 1 つ以上、通った実行は 0） | `failed` |
| 通った実行が 1 つ以上ある（落ちた実行があっても） | `verified` |
| 実行されたが証拠が残っていない | `executed` |
| スクリプトがあるが実行されていない | `implemented` |
| カタログにあるがスクリプトが無い | `designed` |
| カタログにも無い | `uncovered` |

`attempted` 辺が持つ `ok`（トランスクリプトの読み取り結果）と
実行の `status`（runtime 由来）がこの判定の入力である。
辺が**何も言っていない**場合は `unknown` であり、`passed` ではない——
言っていないものを「通った」と読むのは、落ちた実行を
`verified` と報告することになる。

`failed` の順位は `verified` の**下**、`executed` の**上**である：
落ちた実行はチェーンの深さでは通った実行と同じところまで到達している
（実行されて証拠も残った）が、**何も確立していない**ため、
`executed` より上であり `verified` より下である。

### 8.2 逆向き（証拠 -> 要件）

`traceEvidence(view, {uid})` は返す：

* `requirements`：到達した要件（design / testcase / evidence を含む）
* `unreached`：**到達しなかった理由**

`unreached` を必ず返すのは、逆引きが静かに間違え 易い場所であるため。
join が壊れた時の「空の列表」は「この証拠は何も検証しない」と**見える**。
両者は違う事実で、前者だけがプロジェクトに関する指摘である。

逆走査は **run で join する**：

```
evidence <- run <- testcase <- design <- requirement
```

run を経由しない逆走査は、1 つの artifact がプロジェクトの全ケースを検証して
しまう。

---

## 9. この交付が**していない**こと（未実装・未実測）

本書の honesty 規定に従い、以下を明記する。

1. **UI は無い。** React Flow の血缘图は ATS-310（本 issue の兄弟）の領域であり、
   本票は**データ層**に限定した。`apps/studio/app/page.tsx` の既存
   `trace` タブは未変更（`.aitest/requirements.json` を読む既存の read-only 画面）。
2. **増分・影響分析 API は無い。** ATS-309 の領域。本票の
   `/api/traceability` は毎回グラフを**構築する**（読み取り専用で副作用なし）。
   差分評価と影響分析は未実装。
3. **`docs/WBS.xlsx` の「開発WBS」以外のシートは未更新。**
4. **ST 実行の実機証跡は本票の一部ではない。** 本票がasureするのは
   *追跡 model* である。ST 自体が未実行である要件は、グラフ上
   `no-run` gap として**露出する**——これは欠落の可視化であり、
   ST を PASS にすることではない。
5. **実行時 run と Idle 時 run の結合は実測していない。** 本票の IT は
   トランスクリプト由来の run を使う。`state.json` に実 run がある環境で
   `attempted` 辺が張られることは、モデルとして正しいが、本票の証跡では
   トランスクリプト経路しか実行していない。

---

## 10. 実測結果（`docs/evidence/ATS-307/`）

| 項目 | 実測値 |
|---|---|
| ノード | 1354 |
| 辺 | 25862 |
| チェーン（要件） | 49 |
| 孤児辺 | 0 |
| 循環 | 0 |
| present でないノード | 0 |
| 完全なチェーン | 5 |
| 欠けたチェーン | 44 |
| 整合性 `danglingTest` | 0 |
| 整合性 `danglingAnchor` | 0 |
| `falsePass`（偽の主張） | 88 |

`falsePass` 88 件は**本票が発見した既存 drift** である：カタログは
`UT-DSC-001` / `IT-DSC-001` / `UT-QUAL-001` / `UT-ATS213-001` 等を `PASS` と
宣言するが、ツリーに**その ID を宣言するスクリプトが無い**
（実装は別 ID 体系 `ATS-202-UT-001` / `ATS-216-UT-001` 等で書かれている、
あるいは ID を持たない）。これは本票の欠陥ではなく、本票が**報告する
対象**である。修正はカタログとスクリプトの ID 統一を要する別件であり、
本票はそれを隠さない。

---

## 11. 実装の位置

| ファイル | 役割 |
|---|---|
| `server/traceability/model.mjs` | ノード種、辺種、出所、gap 語彙、UID、coverage |
| `server/traceability/builder.mjs` | グラフ構築（カタログ・スクリプト・run・証拠の読み出し） |
| `server/traceability/query.mjs` | 前向き/逆向き walk、coverage レポート、整合性検査 |
| `server/index.mjs` | `GET /api/traceability`（`?requirement=` / `?evidence=`） |
| `tests/ats307-traceability.test.mjs` | UT 33 件 |
| `tests/ats307-traceability-it.test.mjs` | IT 9 件 |
| `tools/ats307-probes/probe-traceability.mjs` | 再現可能なプローブ |

---

## 12. 関連文書

* `docs/10-RTM.md` — 追跡**行列**（本票の入力。並列に保持される）
* `docs/02-REQUIREMENTS.md` FR-026 — 図譜血缘と覆盖缺口
* `docs/03-BASIC-DESIGN.md` B07 — Graph Traceability
* `docs/06-DATA-DESIGN.md` §4 — 実体と整合性規則
* `docs/18-UID-SPEC.md` — UID 方式
* `docs/24-EXECUTION-MODEL.md`（ATS-208）— Run / Test / Attempt 模型
* `docs/27-EVIDENCE-MANIFEST.md`（ATS-209）— Evidence Manifest と SHA-256
* `docs/18-RUNNER-ADAPTER-CONTRACT.md`（ATS-301）— Runner / Reporter 契約
