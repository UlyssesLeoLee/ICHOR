# Test Design: `tools/wbs_common.py`

Source: `tools/wbs_common.py`

Source-SHA256: `52615023214051d6a999861465006ae22cbe1ea0e969fdbf5f77dacc525262f2`

## Test Strategy

pytest. The existing `tools/test_wbs_common.py` (merge idempotence, foreign blocks, marker registration) keeps running unchanged; `tools/test_wbs_common_helpers.py` adds focused tests of the helper branches on small synthetic XML strings and on a temporary copy of the workbook, so the module's line coverage exceeds 90%.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | Every `tools/update_wbs_ats*.py` marker vs `MARKERS` | all registered, including `【ATS-207】` | `tools/test_wbs_common.py` |
| TC-002 | `NARRATIVE_FRAGMENTS['【ATS-506】']` and `NARRATIVE_FRAGMENTS['【ATS-207】']`; `compose_narrative('', 'D6')` and `'D7'` | all fragments present, the cell ends with `。`, ATS-501 fragments still present | `tools/test_wbs_common_helpers.py` |
| TC-003 | `cell_text` / `cell_number` on a missing cell, a cell without `<x:v>`, a non-numeric value, an escaped value | `''`, `''`, `0.0`, the unescaped text | `tools/test_wbs_common_helpers.py` |
| TC-004 | `set_cell` keeps `<x:f>` and style, switches `t="n"`/`t="str"`, escapes `<&>`; missing column and missing row | value replaced, formula kept; `SystemExit` for missing column / row | `tools/test_wbs_common_helpers.py` |
| TC-005 | `merge_marked` with `plain=True` (with and without an existing prefix), `drop_unmarked=True`, `stale_prefixes`/`stale_fragments`, a duplicate own block, an own block already prefixed with the marker | expected cell text for each; second application is a no-op | `tools/test_wbs_common_helpers.py` |
| TC-006 | `set_marked_cell` and `set_narrative_cell` on XML without the cell; with a cell without `<x:v>` | `SystemExit`; a cell written with the merged text | `tools/test_wbs_common_helpers.py` |
| TC-007 | `inflate_zip_entries` on non-zip bytes, on a zip with a stored (method 0) member; `read_parts(copy)` on a temporary copy of the workbook | `SystemExit('not a zip container')`; stored member text; same parts as the repository workbook | `tools/test_wbs_common_helpers.py` |
| TC-008 | `sheet_cells` with shared strings; `totals` with non-numeric K/P and rows outside the ATS range; `totals(parts)` with zero estimate | shared strings resolved; bad numbers ignored; completion rate 0.0 | `tools/test_wbs_common_helpers.py` |

## Boundary & Failure Cases

Markers appearing twice in one cell; a cell whose text ends with `。` (no extra separator); an empty narrative base; escaped XML entities round-trip; a missing row/column always raises `SystemExit` instead of writing a corrupt workbook.

## Regression Scope

Every updater depends on this module. `bash tools/ats501-probes/check-wbs-updaters.sh` is re-run with all updaters (order independence, idempotence, seeded accepted row) and must PASS.
