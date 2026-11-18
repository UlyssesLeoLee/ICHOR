# ATS-307 evidence｜Requirement→Design→TestCase→Script→Run→Evidence 追溯链

本目录是 ATS-307 的实测证据。每一份日志都由
`tools/ats307-probes/collect-evidence.sh` 生成，**可重跑**，且日志头部写明
它描述的 commit。

## 复现

```bash
# 全流程（10 歩）
bash tools/ats307-probes/collect-evidence.sh

# 单步
node --test tests/ats307-traceability.test.mjs          # UT 40 例
node --test tests/ats307-traceability-it.test.mjs       # IT 9 例
node tools/ats307-probes/probe-traceability.mjs         # グラフの実測
node tools/ats307-probes/probe-api.mjs                  # API 面の実測
node tools/ats307-probes/probe-negative-control.mjs     # 負向対照
node tools/ats307-probes/check-readme-consistency.mjs   # README とログの照合
node --test --test-concurrency=2 tests/*.test.mjs       # 全量回帰
```

**歩数・ログ表・用例数はこの README の手で書いた値ではない。**
第 9 歩（`09-readme-consistency.log`）が、本 README の歩数・ログ表・
UT/IT の用例数を**コミット済みのログと照合**する。数がずれたら FAIL する
——つまり、ログを追加して README を更新し忘れると**門禁が赤くなる**。

**第 10 歩は、全量回帰の「1 件だけ失敗」の帰属である。**
全量回帰は 1900 件超を 1 プロセスツリーで走らせるため、宿主が混雑していると
ソケットを保持する用例が失敗する（`ECONNRESET`）。同じツリーが 1 回 0 失敗
次の回 1 失敗になる。`10-suite-flaky-attribution.log` は、そのファイルだけを
再実行し、**このツリーと固定された base ツリーの両方で緑**であることを示す
（`git diff <base> HEAD -- <file>` が空であることも示す）。⇒ この 1 件の失敗は
**コードの回帰ではなく宿主資源由来**である。

プローブは**読み取り専用**である（ツリーに何も書かない）。だから同じツリーで
二回走らせば同じ結果が出る。

## ログ

| ファイル | 内容 | 結果 |
|---|---|---|
| `01-node-test-traceability-ut.log` | UT 40 例 | **40 pass / 0 fail / 0 skipped** |
| `02-node-test-traceability-it.log` | IT 9 例（実 Bridge 上の HTTP 面） | **9 pass / 0 fail / 0 skipped** |
| `03-probe-traceability.log` | 本ツリーのグラフの実測（形・検査・coverage・gap・両方向 walk・commit の覆盖率） | 孤児辺 0 / 循環 0 / present でないノード 0 |
| `04-api-traceability.log` | `GET /api/traceability` の 6 つの問い | 全て期待どおり |
| `05-negative-control.log` | **負向対照**：検査が実際に赤くなることの確認 | **0 failures**（4 種の改変を全て捕捉） |
| `06-node-test-full.log` | 全量回帰（**全量**を保持。`tail` で切っていない） | **1902 tests / 1870 pass / 0 fail / 32 skipped** |
| `07-syntax-gate.log` | 変更したソースの `node --check` | 7 ファイル全て ok |
| `08-skipped-reasons.log` | **skip した 32 件を 1 件ずつ**（理由と所在ファイル） | 32 件を 8 つの理由に分類 |
| `09-readme-consistency.log` | 本 README の歩数・ログ表・用例数とコミット済みログの照合 | **RESULT: OK** |
| `10-suite-flaky-attribution.log` | 全量回帰で出た失敗が**ホスト資源由来**であることの帰属（本票は該当ファイルに触っていない） | **RESULT: OK** |

## 実測値（本ツリー）

| 項目 | 値 |
|---|---|
| ノード | 1358 |
| 辺 | 26833 |
| チェーン（要件） | 49 |
| 孤児辺 | 0 |
| 循環 | 0 |
| present でないノード | 0 |
| 完全なチェーン | 5 |
| 欠けたチェーン | 44 |
| coverage | verified 26 / implemented 2 / designed 21 |
| gap | no-script 140 / no-run 183 / no-declaration 23 / no-testcase 10 |
| `danglingTest` / `danglingAnchor` / `orphanEdge` | 0 / 0 / 0 |
| `falsePass` | **88**（既存の drift。§4 参照） |
| **commit を持つノード** | **1358 / 1358** |
| **commit を持つ辺** | **26833 / 26833** |

### commit の覆盖率（AC-3）

ノードの commit は**その由来ファイルが最後に変更された commit**、辺の commit
は**辺が結ぶ事実の commit**（runtime run が自分の commit を持つ場合はそちらが
優先）。⇒ ノードも辺も commit を持つ。

git の履歴を持たないツリー（`git archive` の出力や一時ディレクトリ）では
commit は**全て null** になる。「commit を持たない”是事実として記録され、
捏造されない（UT-ATS307-039）。

## 1. UT が何を確認しているか

`01-node-test-traceability-ut.log` の 40 例は 8 群に分かれる。

1. **UID**（001〜006）— 同じ入力は同じ UID、kind が違えば UID も違う、
   辺の UID は端点**と**辺種に依存する、**ノードの data は kind と uid を
   上書きできない**、chain の 6 hop、coverage は最深の状態で決まる。
2. **前向き walk**（007〜011）— 要件からスクリプト・run・証拠まで到達する、
   テストケースの無い要件は空の chain ではなく gap を返す、実行されなかった
   ケースは missing-run gap を返す、**欠けた環は補わない**（存在しない
   ノードを捏造しない）、未知の要件は「無い」ではなく「その要件が無い」と報告。
3. **逆向き walk**（012〜015）— 証拠から要件へ到達する、到達できない証拠は
   **理由を**返す（join が壊れているのと、検証するものが無いのは違う）、
   未知の selector は報告、**逆引きは run で join する**（2 つの run が同じ
   ファイル名の artifact を持っても、片方の証拠はもう片方の要件に届かない）。
4. **整合性**（016〜021）— カタログに無いテスト ID は報告、
   どの文書も定義しない設計アンカーは報告、**カタログが PASS と宣言するが
   スクリプトが無いものは偽の主張**、PENDING なら gap であり偽の主張ではない、
   実ツリーに孤児辺も循環も無い、**検査は失敗できる**（意図的な循環を作って
   検出されることを期待する）。
5. **scanner**（022〜027）— 3 種の宣言スタイル（`test('ID: ...')` /
   `verdict('ID ...')` / `check('ID', ...')`）、step suffix の折り返し規則
   （`ST-017a` → `ST-017`、しかし `UT-MOB-011b` は truncation しない）、
   トランスクリプトの読取、ファイルが無いスクリプトはスクリプトではない、
   壊れたファイルは「データ無し」であって crash ではない。
6. **gap と実ツリー**（028〜033）— coverage レポートの gap の内訳、
   gap が hop を名指すこと、**実ツリー**に孤児辺も循環も無いこと、
   実 RTM が名指す ID が全て実カタログに存在すること、
   構築が**決定的**であること（同じツリーは同じグラフを返す）、
   **実ツリー**が両方向に walk できること。
7. **coverage の結果**（034〜036）— 落ちた実行は `verified` ではなく `failed`、
   落ちた実行と通った実行の両方を持つケースは `verified`、
   `failed` の順位は `verified` の**下**かつ `executed` の**上**。

### commit（AC-3）

8. **commit**（037〜040）— commit を持つ runtime run は**ノード**と**辺**の
   両方にその commit を載せる（037）。**実ツリー**のノード 1358/1358 と
   辺 26833/26833 が commit を持つ（038）。git の履歴を持たないツリーでは
   commit は**全て null** で、捏造しない（039）。ノードの commit は
   **そのノードの由来ファイル**に対する `git log -1` が返す commit と
   **一致**する——派生であって手書きではない（040）。

## 2. 負向対照が守ること

`05-negative-control.log` は、**検査が赤くなること**を証明する。検査が赤く
ならない検査は何も証明しないからだ。4 種の改変を一つずつ作り、それぞれが
対応する検査で捕捉されることを確認する：

1. カタログに無いテスト ID を RTM に足す → `danglingTest` が赤くなる
2. どの文書も定義しない設計アンカーを足す → `danglingAnchor` が赤くなる
3. 実装スクリプトの無いケースを PASS と宣言する → `falsePass` が赤くなる
   （同じケースを PENDING にすると `falsePass` は赤く**ならない**——
   gap であり偽の主張ではないことも同時に確認する）
4. データに有向閉路を作る → 循環検出が赤くなる（閉路を持たないグラフでは
   0 件になることも確認する）

## 3. API 面

`04-api-traceability.log` は実際の Bridge プロセスを起動して
`GET /api/traceability` を叩く。

| 問い | 期待 |
|---|---|
| token 無し | 401 |
| 汇总 | ノード数・辺数・チェーン数・coverage・gap 一覧・検査結果・整合性 |
| `?requirement=FR-015` | 6 hop の chain と gap 一覧 |
| `?requirement=FR-022` | 欠けた hop が**名前つきで**出る（`no-testcase`, hop 2） |
| `?evidence=<uid>` | 到達した要件（design / testcase 付き） |
| `?requirement=FR-999` | `found: false` と理由 |

## 4. 本票が報告する既存の drift（88 件）

カタログは `UT-DSC-001` / `IT-DSC-001` / `UT-QUAL-001` / `UT-ATS213-001` 等を
`PASS` と宣言するが、**ツリーにその ID を宣言するスクリプトが無い**。
実装は別の ID 体系（`ATS-202-UT-001` / `ATS-216-UT-001` 等）で書かれている、
あるいは ID を持たない。

これは本票の欠陥ではなく、**本票が報告する対象**である。修正はカタログと
スクリプトの ID 統一を要する**別件**であり、本票はそれを隠さない。

内訳（`03-probe-traceability.log` §4）：

| 系列 | 件数 |
|---|---|
| UT-DSC-* | 30 |
| UT-ATS213-* | 17 |
| IT-DSC-* | 11 |
| IT-ATS213-* | 11 |
| UT-QUAL-* | 9 |
| IT-DSC-API-* | 7 |
| IT-DSC-SETUP / IT-DSC-CLEANUP / ST-045 | 各 1 |

## 4b. skip した 32 件（1 件ずつ）

`node --test` は skip の**件数**しか出さない（`skipped 32`）。
**件数は台帳ではない**——何が走らなかったかは読めない。
`08-skipped-reasons.log` は TAP レポーター（TAP は skip 行に理由を付ける）
で走らせた結果から、skip した 32 件を**理由ごとに全件**並べたもの。

| 件数 | 理由 | 何が足りないか |
|---|---|---|
| 11 | `no Android device is attached to adb` | Android 実機／エミュレータが無い（ATS-603 の範疇） |
| 6 | `examples/sample-playwright has no node_modules` | サンプル工程的依存が未インストール |
| 4 | `examples/sample-wdio has no node_modules` | 同上（WDIO 側） |
| 4 | `needs ATS402_REAL_CREDENTIAL_STORE=1` | 本物の Windows 資格情報ストアを触らない |
| 3 | `npm ci failed (exit 1): npm error code EALLOWREMOTE` | レジストリが `remote` 型の取得を拒否（ATS-107 の実ブラウザ夹具） |
| 2 | `no real @playwright/test installation` | 実 `@playwright/test` のインストールが無い |
| 1 | `the fixtures have no node_modules` | 上記 2 種を同時に要求する |
| 1 | `needs ATS213_REAL_CREDENTIAL_STORE=1` | 本物の資格情報ストアを触らない（ATS-213 の redact テスト） |

**PENDING は PASS ではない。** 32 件は**未実行**であり、
上の理由がそのまま未実行の理由である。合算して「PASS」と数えてはならない。

## 5. 未検証・未実行の項目

**PENDING は PASS ではない。** 本票が実測したのは *追跡 model* であり、
ST 自体ではない。ST が未実行の要件はグラフ上 `no-run` gap として**露出**する。
これは欠落の可視化であって、ST を PASS にすることではない。

* **UI は無い。** React Flow の血缘图は ATS-310 の領域。本票はデータ層に限定し、
  `apps/studio/app/page.tsx` の既存 trace タブは未変更。
* **増分関係校验と変更影響評価 API は無い。** ATS-309 の領域。
  `/api/traceability` は毎回グラフを構築する読み取り専用。
* **実行時 run（`state.json` 由来）との結合は、本票の証跡では
  トランスクリプト経路しか実行していない。** モデルとして正しいが、
  実 run がある環境での結合は実測していない。
* **ST の実機証跡は本票の一部ではない。** 上記のとおり。
