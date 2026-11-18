# ATS-308 証拠（設計資料索引器）

本目录是 **ATS-308（IPA 设计资料与 .aitest 追踪资产导入）** 的实测证据。
每一份 log 都是**某条命令在这台机器上真的打印出来的东西**，不是对它的描述。

采集脚本：`tools/ats308-probes/collect-evidence.sh`
（一次跑完 7 步，最后一行是 `RESULT: OK -- every step of the ATS-308
evidence collection passed.`）。

**每份 log 的头部写明它描述的是哪一个 commit**（`commit : <sha>`）。没有
commit 的 log 是没有树依附的数字，而没有树的数字会在别的票一碰 `docs/`
就过期——第一次采集就是如此：探针在一棵树上量到 1058 resolved，树长了，
设计书却还在引 1058。

## ログの一覧

| ログ | 手順 | 実測結果 |
|---|---|---|
| `01-node-test-import-ut.log` | `node --test tests/ats308-import.test.mjs` | **tests 31 / pass 31 / fail 0** |
| `02-node-test-import-it.log` | `node --test tests/ats308-import-it.test.mjs` | **tests 9 / pass 9 / fail 0**（実 Bridge、HTTP） |
| `03-node-test-import-mutation.log` | `node --test tests/ats308-import-mutation.test.mjs` | **tests 7 / pass 7 / fail 0**（**負控 7 変異が 7 変異を捕捉**） |
| `04-probe-design-import.log` | `node tools/ats308-probes/probe-design-import.mjs` | **`RESULT: OK -- 1061 resolved references all name files that exist.`** |
| `05-ats301-gate.log` | `bash tools/ats301-probes/check-ats301-gate.sh` | **`RESULT: OK -- the WBS helper regression, the ADR citation check and the port audit all pass.`** |
| `06-wbs-update.log` | `python tools/update_wbs_ats308.py`（2 回）+ `show-wbs-row.py ATS-308` | ATS-308 行 = `待审核` / `1` / `0`、マーカー 1 個、総覧の派生値がシートと一致 |
| `07-doc-consistency.log` | `node tools/ats308-probes/check-doc-consistency.mjs` | **`RESULT: OK -- every figure the documents quote is the committed log's figure.`** |

## 04 のプローブが実測した数字

プラットフォーム自身の設計ベースライン（`docs/` 56 文書 + 追跡資産 3 個）:

```
resolved      : 1061
runtime       : 76
ambiguous     : 14
external      : 16
broken        : 41
TOTAL         : 1208
```

**ベースラインは本票の産物（`docs/35-DESIGN-IMPORT.md` と本 README）を
除外する。** 除外しないと、本票が自分の文章を編集するだけで測定値が
動く——README は `show-wbs-row.py` を名指しし、これはツリーに 2 個ある
ので README 1 行が AMBIGUOUS を 1 件と設計文書 1 件を増やす。§9 の表は
残りのツリーだけの関数になる。

`broken` の 41 箇所は**実在の欠陥ではない**（issue 添付の復核プローブ 25、
他ツリーの旧ファイル名 12、実行時生成物 4）。内訳は
`docs/35-DESIGN-IMPORT.md` §9.1 に**実測値**として書いてある。

**プローブは自検もする**——`resolved` と判定された**全 1061 参照**の候補が
**1 件ずつ実在するファイル**であることを確認してから `RESULT: OK` を出す。

## 数字は散文ではなく**検査される**

`07-doc-consistency.log` は、本 README と `docs/35-DESIGN-IMPORT.md` と
`docs/00-INDEX.md` と `tools/update_wbs_ats308.py` が**引用する数字**を、
コミット済みのログの数字と**一対一で照合する**。ずれたら FAIL する。
だから「ログを追加して README を更新し忘れる」と**門禁が赤くなる**。

## 05 の ATS-301 ゲートが緑である理由

本票は `server/index.mjs` に**コードを追加**した（`GET /api/design/import`
と `GET /api/projects/:id/import`）。ADR（`docs/16-BASELINE-ADR.md` §3.1）は
`server/index.mjs` の**行番号**を引用しているため、**行がずれる**。
引用を**新しい位置へ追従**させた（`:94` → `:100`、`:290` → `:296`、
`:1468-1498` → `:1474-1504`、`:2422` → `:2469`、`:2471`/`2472` →
`:2518`/`:2519`、`:1511` → `:1517`、`:1737` → `:1761`、`:1482` → `:1488`、
`:1500` → `:1506`）ので、ゲートは緑のまま。

## 07 に対する反証（負控）

`03-node-test-import-mutation.log` の 7 件は**导入器を複製して変異させ**、
変異後の挙動が**誤り**であることを確かめたもの:

| 変異 | 何が報告されるか |
|---|---|
| M1 | 壊れリンクを報告しない → 報告が空になる |
| M2 | 重名リンクを報告しない → 報告が空になる |
| M3 | 壊れリンクを「已解析」と称する → **存在しないファイル**を候補に挙げる |
| M4 | 実行期生成物を「失效」と称する → 報告が**毎回**叫ぶ |
| M5 | 外部パスを「失效」と称する → 報告が**偽の欠陥**を挙げる |
| M6 | 正文に追記する → **正文が変わる**（受入基準の違反） |
| M7 | 複数の候補から 1 つを乱猜する → **事実を捏造**する |

各テストは**両方向**を確かめる——変異後の挙動が誤りであること**と**、
変異していない実装が正しいこと。**後半だけ**を確かめるテストは、
元から壊れた実装でも通ってしまう。

## 再現 방법

```bash
bash tools/ats308-probes/collect-evidence.sh
```

ブラウザ・デバイス・ネットワークは**要らない**。导入は
**ディスク上のファイル**に対する索引付け作業である。
