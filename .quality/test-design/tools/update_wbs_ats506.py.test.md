# Test Design: `tools/update_wbs_ats506.py`

Source: `tools/update_wbs_ats506.py`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Test Strategy

pytest tests in `tools/test_update_wbs_ats506.py`. Each test copies the committed `docs/WBS.xlsx` into a pytest `tmp_path` and runs `main(['--xlsx', copy, ...])` in-process, so the repository workbook is never touched and coverage is attributed to the real module. Results are read back with `wbs_common.read_parts` / `sheet_cells` / `totals`. Coexistence with the other updaters is additionally checked by `bash tools/ats501-probes/check-wbs-updaters.sh`.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | Copy of the workbook; `main(['--xlsx', copy])` | ATS-506 row: N=`待审核`, O=`1`, P=`0`; T contains `【ATS-506】` and `docs/21-CONTROL-PLANE-API.md` | `tools/test_update_wbs_ats506.py` |
| TC-002 | `main(['--xlsx', copy, '--status', '进行中'])` | N=`进行中`, O=`0.6`, P = K × 0.4 (`2.8` for K=7); P keeps its formula | `tools/test_update_wbs_ats506.py` |
| TC-003 | Run TC-001 twice | the second run leaves the file byte-identical | `tools/test_update_wbs_ats506.py` |
| TC-004 | Seed N=`已完成` in the ATS-506 row of the copy, then run | N stays `已完成` | `tools/test_update_wbs_ats506.py` |
| TC-005 | Copy whose ATS-506 T cell holds the `【ATS-501】` note | after the run both `【ATS-501】` and `【ATS-506】` blocks are present | `tools/test_update_wbs_ats506.py` |
| TC-006 | After the run | 总览 B8/B9/B10 equal `totals(parts)` (completed, `format_rate(rate)`, remaining); D6/D7 contain the ATS-506 fragments | `tools/test_update_wbs_ats506.py` |
| TC-007 | After the run | every member except sheet1/sheet2 is byte-identical to the input; no `.bak` beside the copy; rows other than ATS-506 unchanged in sheet2 | `tools/test_update_wbs_ats506.py` |
| TC-008 | `main(['--status', '已完成'])` | `SystemExit` with code 2 (argparse) | `tools/test_update_wbs_ats506.py` |
| TC-009 | `find_ats_row` on XML without the ID | `SystemExit` naming the ID | `tools/test_update_wbs_ats506.py` |

## Boundary & Failure Cases

Terminal statuses `已完成` and `已取消` are both protected; the cached remaining value is computed from the row's K (no hardcoded 7); a missing workbook path fails with the OS error; a status outside the two allowed values never reaches the workbook.

## Regression Scope

All other updaters share the workbook: `tools/ats501-probes/check-wbs-updaters.sh` (order independence, idempotence, seeded 已完成 row, marker survival, D6/D7 composition) must pass with this script discovered. `tools/test_wbs_common.py` must pass (marker registered).
