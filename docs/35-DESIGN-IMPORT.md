# ATS-DD-035 設計資料索引器（ATS-308｜S3 / v0.3.0｜导入）

- 文書 ID: ATS-DD-035
- 対応 WBS: ATS-308（S3 / v0.3.0 / 导入 / BE）
- 対応要件: FR-026（Requirement→Script→Run→Evidence 可查询和影响分析）／ FR-017（需求关系读取）
- 基準日: 2026-11-18
- 状態区分の凡例: `IMPLEMENTED` = コード実装済みかつ実測証拠あり / `DESIGNED` = 設計のみで未実装
- 本書の中心命題: **导入は「読む」だけで「書かない」。** 壊れたリンクを直すツールは
  別のツールであり、**黙って**直すツールは嘘をつくツールである。

---

## 1. 目的と完了定義

ATS-308 の完了定義は次の 2 項目である。

| # | 完了定義 | 本書での該当箇所 | 状態 |
|---|---|---|---|
| AC-1 | 导入 md/json 关系不改正文 | §4 読み取り専用性 / §9 実測 | IMPLEMENTED |
| AC-2 | 失效/重名链接输出报告 | §5 分類器 / §6 報告書 / §9 実測 | IMPLEMENTED |

**「不改正文」は禁止事項ではなく主張である。** 索引器は 43 文書を
開き、関係を読み、報告を返すが、**1 バイトも書き戻さない**。§4 で
「なぜ書き戻さないことが設計であるか」を述べる。

---

## 2. なぜ既存（`GET /api/projects/:id/lineage`）では足りなかったか

既に `/lineage` は `.aitest/requirements.json` と `.aitest/traceability.json`
を**生で**返している（`server/index.mjs`）。FR-017「需求关系读取」が
書いているのはその**生読み**だけである。

その生読みでは足りないのは 3 つある。

1. **関係は読めても、壊れているかが分からない。** `traceability.json` の
   リンクが、要件一覧に無い要件を指している。用例が改名されているのに
   リンクが古い。**生データは今日の状態を述べるが、
   壊れたリンクがどこにあるかは述べない。**
2. **設計資料という側の関係は、 altogether 見ていなかった。** `.aitest` は
   JSON 2 個だが、設計資料は `docs/` の Markdown 43 ファイルで、
   **そちらのほうが関係が多い**（実測 1205 参照）。B07
   「Graph Traceability」の設計は「要件/关联读取 → `.aitest/*.json`」と
   書いているが、実装は**片方の半分しか見ていない**。
3. **報告が無い。** 壊れたリンクを**列挙**する場所が無い。読者は
   43 ファイルを自分で grep するしかない。

本票が**満たす**のはこの 3 つを**索引器**として成立させること。すなわち
「読み・索引・報告」であり、「repair」は**含まない**。

---

## 3. 二種類の資料

### 3.1 設計資料（Markdown）

`docs/` 配下の Markdown。**章番号を持ち**、他文書・ソース・道具・
証拠を指す。索引器の主対象。

### 3.2 追跡資産（JSON）

要件一覧と追跡一覧（`tests/rtm.json`、およびプロジェクトの
`.aitest/requirements.json` / `.aitest/traceability.json`）。
**関係を持つ**のはこちらで、**参照（ファイルパス）を持たない**。

この 2 つは**別物**であり、**別々に失敗する**。Markdown は
「章番号が無い」「ファイルが無い」で壊れ、JSON は「要件が宣言されて
いない」「リンクが重複している」で壊れる。索引器は両方の語彙を
**別の閉じられた集合**として持つ。

---

## 4. 読み取り専用性——なぜ「書かない」ことが設計であるか

完了定義 AC-1 は「导入 md/json 关系不改正文」である。これは
**禁止事項**のように読めるが、実は**設計の核心**である。

* 索引器が壊れたリンクを**自動修復**したら、その報告は
  **もう信用できない**。「壊れていたリンクが 0 件」という報告は、
  「壊れていたリンクを全部直した」という報告に変わる。後者は
  **何を直したか**を持たないので、**差分の証拠にならない**。
* 設計資料は**人**が読む。索引器が本文を書き換えたら、**差分に
  設計以外の物**が混ざる。「この commit で設計が変わったか」を
  問う操作が壊れる。
* ATS-307（追跡グラフ）が **「gap は埋めない」**という原則を
  掲げている。ATS-308 は同じ原則の**別面**である——**参照の
  欠落を埋めず、報告する**。

⇒ 索引器は**ファイルを開き、分類し、返す**。**書かない**。
API にも** POST はない**（`GET` しか無い）。その absence を
UT-ATS308-001 / IT-ATS308-API-003 / IT-ATS308-API-004 が
**実測**で守る。

---

## 5. 分類器——参照の 5 つの verdict

参照は 1 本の**インラインコードスパン**（`` `server/index.mjs` ``）で
書かれる。これは**リポジトリが実際に使っている唯一の規約**である
（計測: 43 文書、1205 参照、**Markdown リンクは 0 本**）。
Markdown パーサを**再実装しない**のはこのためである。

判定は 8 段の**順序**で、**第一条**で必ず決着する。

| 順 | 条件 | verdict |
|---|---|---|
| 1 | 書かれたとおりに存在 | `resolved` |
| 2 | 末尾一致で**ちょうど 1 個**の追跡ファイルに一致 | `resolved` |
| 3 | 裸の basename が**ちょうど 1 個**のファイルに一致 | `resolved` |
| 4 | 裸の basename が**複数**のファイルに一致 | `ambiguous` |
| 5 | 裸の basename が**どのファイルにも**一致せず、**ランタイム生成物**の名前 | `runtime` |
| 6 | 先頭セグメントが**ビルド出力ディレクトリ**（`out/` `node_modules/` …） | `runtime` |
| 7 | ディレクトリが**このリポジトリに無い** | `external` |
| 8 | それ以外 | `broken` |

### 5.1 `external` という区別が**報告の有用性**を左右する

設計文書は**プラットフォーム**と**被执行されるプロジェクト**の
両方を説明する。だから `flows/android.yaml` や `tests/a.spec.ts` のような
**このリポジトリには無いディレクトリ**の参照が現れる。

これらを `broken` にすると、**報告のたびに偽の欠陥が 12 件**入る。
偽の欠陥を含む報告は**誰にも読まれない**。

判定は機械的で検査できる: **文書が名付けたディレクトリが
このリポジトリに無いなら、その参照は別のものを指している。**
ディレクトリが**有るのにファイルが無い**のは**本物の壊れリンク**。

### 5.2 `runtime`——cry wolf を避ける

`state.json` / `report.json` / `manifest.json` は**実行時にしか
存在しない**。これらを `broken` にすると、報告は**毎回**同じことを
叫ぶ。語彙は**閉じている**: この集合に無い名前は**木の通常の
ファイルとして解決される**ので、**未知のランタイム生成物は
`broken` として現れる**（黙って免除しない）。

### 5.3 末尾一致は「推測」に**ならない**範囲だけ許す

文書は 2 通りの書き方をする: リポジトリの完全パス
（`server/index.mjs`）と、**文書の話しているディレクトリ内の**パス
（`src-tauri/src/lib.rs` に対する `lib.rs`）。完全パスだけを受け付ける
Resolver なら**正当な参照 30 余件**を `broken` として報告する。

一方、末尾一致は**推測機械**になってはいけない。だから
**追跡ファイルにちょうど 1 個**一致するときだけ受け付ける。
2 個なら `ambiguous` で、**1 個は選ばない**。

### 5.4 `ambiguous` は `broken` ではない

`package.json` はこのリポジトリに **5 個**ある。`index.mjs` は **4 個**。
その参照は**間違っていない**——**不完全**である。読者は
「文書が**どれ**を言ったのか」を知らない。1 つに**解決**する 것은
**事実の捏造**である。よって `ambiguous` は**候補を全部**报告する。

---

## 6. 報告書

報告は**機械可読**（`report`）と**人可読**（`formatImportReport`）の
2 形を持つ。

* `byKind` — verdict ごとの件数。**合計は参照総数と一致する**
  （UT-ATS308-031 が確認）。
* `broken` — **token ごとに束ねた**一覧。壊れたリンクが 12 箇所に
  書かれていても、**欠陥は 1 つ**であって 12 ではない。よって
  token ごとに 1 エントリとし、**参照箇所を全部**載せる。
* `ambiguous` — 同上。**候補**も載せる。

追跡資産側は別に 6 種の issue 語彙を持つ:
`dangling-requirement` / `duplicate-requirement` / `duplicate-link` /
`malformed-target` / `missing-file` / `unknown-case`。

### 6.1 `to` フィールドの規約

プラットフォームの規約（`examples/sample-playwright/.aitest/`）は
`file::test title` である。索引器は**タイトルを UID に解決しない**——
UID はプロジェクト依存（ATS-202/ATS-204）であり、**タイトル**が
ここでは正直な答えである。ただし**そのファイルがそのタイトルを
宣言しているか**は**検査する**（用例が改名された drift を捕まえる）。

用例タイトルの走査は**プラットフォーム自身の走査器**
（`server/uid.mjs` の `scanTestCases`）を使う。**再実装しない**のは、
両者が**ずれる**と「明明存在する用例に『存在しない』と報告する」
ことになるから。走査器が使えない場合の**フォールバック**は
**保守的**である（**足すだけ**で、**減らさない**）。

---

## 7. API 面

| メソッド | 経路 | 意味 |
|---|---|---|
| GET | `/api/design/import` | プラットフォーム**自身**の設計ベースライン indexing（`?detailed=true` で参照明细） |
| GET | `/api/projects/:id/import` | **登録プロジェクト**の追跡資産 + そのプロジェクト樹の設計資料 |

両方とも**読み取り専用**で、**セッショントークン**が要る
（IT-ATS308-API-005）。**POST は無い**（IT-ATS308-API-004）。

`/api/projects/:id/lineage`（既存）は**生読み**のままである。
壊れたリンクの**報告**が要るときは `/import` を使う。

---

## 8. UID の規則

| 実体 | uid | 基準 |
|---|---|---|
| 資料 | `dmi_1_<24 hex>` | `sha256("material" ␀ path)` |
| 参照 | `dmr_1_<24 hex>` | `sha256("reference" ␀ path ␀ line ␀ token)` |
| 資産 | `ast_1_<24 hex>` | `sha256("asset" ␀ project ␀ name)` |
| 要件 | `asr_1_<24 hex>` | `sha256("requirement" ␀ project ␀ uid)` |
| リンク | `asl_1_<24 hex>` | `sha256("link" ␀ project ␀ from ␀ to ␀ type)` |

基準は**位置でも counter でもない**。だから同じ木は**常に同じ索引**を
作り、索引は **commit をまたいで差分できる**（ATS-307 の UID 規約と
同じ方式族）。**同一参照の 2 行目は別の事実**なので、
参照 uid には**行番号**が入っている。

---

## 9. 実測結果（`docs/evidence/ATS-308/`）

プラットフォーム自身の設計ベースライン（`docs/` 43 文書 + 追跡資産 3 個）
に対する**実測**（本票の新規文書 `docs/35-DESIGN-IMPORT.md` を**除外**した
数値——それは本票が**追加した**文書であり、ベースラインではない）：

| verdict | 件数 |
|---|---|
| `resolved` | 1058 |
| `runtime` | 76 |
| `ambiguous` | 14 |
| `external` | 16 |
| `broken` | 41（**16 種の token**、41 箇所の出現） |
| **合計（参照総数）** | **1205** |

`byKind` の合計が参照総数と一致することは UT-ATS308-031 が**実測**で
確認する。

### 9.1 `broken` の 41 箇所の内訳——**実在の欠陥ではない**

41 箇所を**出所別に分けると**、**3 種**に収まる。**どれも「ファイルが
無くなった」ためではない**。

| 種別 | 箇所 | token（出現数） | 何であるか |
|---|---|---|---|
| **外部復核プローブ** | 25 | `r1-api.mjs`(6) `r1.mjs`(3) `r2-api.mjs`(3) `r2.mjs`(2) `ce.mjs` `http.mjs` `ce206.mjs` `ce206k.mjs` `ce206r2.mjs` `e2e206.mjs` `k4.mjs` `r1-ui.mjs` `r2-inproc.mjs` `r2-ref-leak.mjs` `r2-ui.mjs` | **issue の添付ファイル**。`docs/evidence/ATS-403/reviewer-probes/` に在るのは**その出力**（`.log`）であって**プローブ本体**。**一度も commit されたことがない** |
| **別ツリーのファイル** | 12 | `404.html`(3) `index.html`(2) `login.spec.ts`(2) `tests/login.spec.ts` `tests/new.spec.ts` `tests/a.spec.ts` `tests/cart.spec.ts` `tools/migrate_state.py` | 文書が**別のリポジトリ状態**のファイル名を記した。`tools/migrate_state.py` は `server/migration/state-migration.mjs` に**改名**された。`index.html`/`404.html` は Next.js の**静的出力**のファイル名（`out/` を**省略**して書いてある） |
| **他プロジェクトの実行時生成物** | 4 | `error-context.md`(2) `cli.js` `SHASUMS256.txt` | **実行時に書かれる**名前。`error-context.md` は Playwright の HTML レポートが出すもの、`cli.js` は `node_modules` 内の Playwright CLI、`SHASUMS256.txt` は **npm** の配布物名 |

**この分類は「ドキュメントに欠陥がない」という主張ではない。**
索引器の語彙には「存在しないファイルへの参照」**しか**無く、
その**実情**（添付ファイルか、他ツリーか、生成物か）を**別の道具**で
判定した結果を**併記した**ものである。**索引器自身は区別しない**
——§11 の限界でもある。

### 9.2 `external` の 16 件

`apps/studio/app/api/session/route.ts`(2) `flows/android.yaml`
`flows/ios.yaml` `flows/smoke/login.yaml` `auth/login.spec.ts`
`apps/studio/out/index.html` `platform_impl/windows/event_loop.rs`
`playwright-core/browsers.json` `playwright/lib/worker/workerProcessEntry.js`
`probes/r1-api.mjs` `probes/r1-ui.mjs` `probes/r1-ui-run.mjs`
`probes/r2-extra.mjs` `probes/r2-ui.mjs` `x/tests/a.spec.ts`。
**このリポジトリに無いディレクトリ**を指す参照——§5.1 の規則が
**期待どおりに**働いた例である。

### 9.3 `ambiguous` の 14 件

| token | 出現 | 候補数 | 実在する候補 |
|---|---|---|---|
| `playwright.config.ts` | 5 | 2 | `examples/real-browser-fixture/` `examples/sample-playwright/` |
| `index.mjs` | 3 | 4 | `server/index.mjs` `server/ai/index.mjs` `server/discovery/index.mjs` `examples/sample-plugin/index.mjs` |
| `mutation-check.mjs` | 3 | 4 | `tools/ats107-probes/` `ats111-probes/` `ats214-probes/` `ats216-probes/` |
| `errors.mjs` | 2 | 2 | `server/ai/errors.mjs` `server/control-plane/errors.mjs` |
| `collect-evidence.sh` | 1 | 31 | `tools/ats1xx-probes/` … `tools/ats6xx-probes/` の 31 本 |

**どれも実在する重名**であり、**誤検出ではない**。索引器は
**1 つも選ばない**。

### 9.4 `runtime` の 76 件

`state.json`(48) `report.json`(16) `evidence-cleaned.json`(4)
`out/index.html`(2) `out/404/index.html` `out/_not-found/index.html`
`html/index.html` `lnk/state.json` `credentials.json`
`node_modules/.package-lock.json`。**§5.2 の規則が効いている**。

### 9.5 壊れリンクの**発見能力**は**実測**で確認した

`tools/ats308-probes/probe-design-import.mjs` は**実リポジトリ**を読み、
`resolved` と判定された**全 1058 参照**の候補が**実在するファイル**で
あることを**1 件ずつ**確認する。

```
resolved references checked : 1058
candidates that do not exist: 0
RESULT: OK -- 1058 resolved references all name files that exist.
```

**⇒ 「存在しないファイルへの参照を見つける」能力は実測で確認できた。
ただし §11 の限界を伴う。**


---

## 10. この交付が**していない**こと（未実装・未実測）

本書の honesty 規定に従う。

1. **壊れたリンクは**直していない**（§4）。**意図的**である。
2. **UI は無い。** `/api/design/import` を表示する画面は
   **作っていない**。ATS-310（React Flow）の領域であり、本票は
   データ層に限定した。
3. **増分・影響分析 API は無い。** ATS-309 の領域。
4. **§ 番号の検証は**実装していない`。** 索引は**章番号を読み**、
   § 参照の**照合はしていない**。§ 参照は実測で 99 件すべて
   解決可能だったが（`docs/` 内の相互参照）、その**照合 logic は
   本票に無い**。
5. **`docs/WBS.xlsx` の「開発WBS」以外のシートは未更新。**
6. **「対象プロジェクトの設計資料」の索引は**未実装**。** 現在の
   `/api/projects/:id/import` は**プロジェクト自身の** `docs/` を
   索引する。プロジェクトが**別の**設計基準を持つ場合の
   索引は**範囲外**。

---

## 11. 既知の限界（実測で確認した）

1. **`broken` の語彙は「実在の欠陥」と「別の種類の不在」を
   分けない。** §5.1 の規則は「ディレクトリが**このリポジトリに無い**
   なら `external`」であり、これは**期待どおりに**働いた（実測で
   `flows/android.yaml` `auth/login.spec.ts` などが `external` に
   なった）。**しかし**同じ「被テストプロジェクトのファイル」性質の参照
   でも、**ディレクトリが**このリポジトリに**存在するとき**は
   `broken` になる——`tests/a.spec.ts` `tests/login.spec.ts`
   `tests/cart.spec.ts` `tests/new.spec.ts` がそれで、**`tests/` は
   このリポジトリに実在する**（自分自身のテストディレクトリ）。
   よって**同一の「被テストプロジェクト」を指す参照が、
   ディレクトリ名によって `broken` と `external` に分かれる**。
   **これは §5.1 の規則そのものの限界**であり、
   **「壊れているリンクの報告」が真の欠陥より**強く**出る**面がある。
   §9.1 の内訳表は、その**過大さ**を**実測値**で示している。

2. **裸の basename は**より弱い**。`index.html` は `broken` だが
   `out/index.html` は `runtime`。**先頭セグメントの判定は
   パスつき参照にしか効かない**。同じ理由で `404.html`（Next.js の
   静的出力）も `broken` になる。

3. **`runtime` の語彙は**閉じている**。§5.2 の通り、集合に無い
   名前は**通常のファイルとして解決**されるので、**未知の**実行時
   生成物は `broken` として現れる（`error-context.md`
   `SHASUMS256.txt` がそれ）。**黙って免除しない**ことは
   設計の意図だが、**過大さ**も必然である。

4. **用例タイトルの照合は**プラットフォームの走査器**に依存**。
   走査器が使えない環境では**フォールバック**が使われるが、
   フォールバックは**保守的**（**足すだけ**）なので、
   **`unknown-case` の誤検出は起きない**が、
   **`unknown-case` を見逃す可能性**がある。

5. **索引は**文書**単位で**、**行**は**参照**の属性**として**持つ。**
   **セクション単位の索引は無い**（§10-4）。

---

## 12. 実装の位置

| ファイル | 役割 |
|---|---|
| `server/import/design-index.mjs` | 分類器・参照抽出・資料索引・報告書 |
| `server/import/tracking-assets.mjs` | 追跡資産（`.aitest`）の読込・関係検査・issue 語彙 |
| `server/index.mjs` | `GET /api/design/import` / `GET /api/projects/:id/import` |
| `tests/ats308-import.test.mjs` | UT 31 件 |
| `tests/ats308-import-it.test.mjs` | IT 9 件（実 Bridge、HTTP） |
| `tests/ats308-import-mutation.test.mjs` | 負控 7 件（**7 変異が 7 変異を捕捉**） |
| `tools/ats308-probes/` | 再現可能なプローブ |

---

## 13. 関連文書

* `docs/33-TRACEABILITY-GRAPH.md`（ATS-307）— 追跡グラフ。本票の索引は
  その `design` ノードの入力になる。
* `docs/10-RTM.md` — 追跡**行列**（本票の入力。並列に保持される）
* `docs/02-REQUIREMENTS.md` FR-017 / FR-026 — 需求关系读取 / 图谱血缘
* `docs/03-BASIC-DESIGN.md` B07 — Graph Traceability
* `docs/06-DATA-DESIGN.md` §3 — 目标逻辑 ER
* `docs/18-UID-SPEC.md` — UID 方式
* `docs/18-RUNNER-ADAPTER-CONTRACT.md`（ATS-301）— Runner / Reporter 契約
* `docs/24-EXECUTION-MODEL.md`（ATS-208）— Run / Test / Attempt 模型
