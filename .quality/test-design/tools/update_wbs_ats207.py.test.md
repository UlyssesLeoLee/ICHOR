# Test Design: `tools/update_wbs_ats207.py`

Source: `tools/update_wbs_ats207.py`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Test Strategy

The tests are pytest, in `tools/test_update_wbs_ats207.py`.
- Every test edits a copy of `docs/WBS.xlsx` under `tmp_path`, so the repository workbook is never written.
- Cells are read back with `wbs_common.read_parts` / `sheet_cells`.
- openpyxl loads the result to prove it parses.
- The file is part of the pytest command in `.quality/qguard.json`, so its coverage counts toward the gate.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | `main(['--xlsx', copy])` | row N/O/P = 待审核 / 1 / 0; T contains `【ATS-207】` once and names `docs/06-DATA-DESIGN.md`; stdout `updated` | `tools/test_update_wbs_ats207.py` |
| TC-002 | `main(['--status', '进行中', '--xlsx', copy])` | N/O/P = 进行中 / 0.6 / K*0.4 | `tools/test_update_wbs_ats207.py` |
| TC-003 | run twice | sheet2 and sheet1 bytes identical after the second run; the marker still appears once | `tools/test_update_wbs_ats207.py` |
| TC-004 | row pre-set to 已完成 / 1 / 0, then the updater runs with 待审核 | N/O/P stay 已完成 / 1 / 0; note refreshed | `tools/test_update_wbs_ats207.py` |
| TC-005 | a foreign `【ATS-206】` block already in T | the foreign block survives next to the ATS-207 block | `tools/test_update_wbs_ats207.py` |
| TC-006 | 总览 B8/B9/B10 after the update | equal to `wbs_common.totals` of the written workbook; D6/D7 contain the ATS-207 fragments | `tools/test_update_wbs_ats207.py` |
| TC-007 | openpyxl loads the updated copy (normal and data_only) | loads; the ATS-207 row is found; column P keeps its formula | `tools/test_update_wbs_ats207.py` |
| TC-008 | `find_ats_row` on XML without the row | `SystemExit` | `tools/test_update_wbs_ats207.py` |
| TC-009 | every other zip member | byte-identical to the original workbook | `tools/test_update_wbs_ats207.py` |

## Boundary & Failure Cases

- An accepted row is never downgraded.
- A note containing `<`, `>` or `&` would break the XML, so the note is escaped by `wbs_common`.
- A missing row raises `SystemExit` instead of writing a partial workbook.
- `--status` outside the two allowed values is rejected by argparse with exit code 2.

## Regression Scope

`tools/test_wbs_common.py` (marker registration) and `tools/test_wbs_common_helpers.py` (narrative composition). The other `update_wbs_*` updaters must stay order-independent on the shared cells.
