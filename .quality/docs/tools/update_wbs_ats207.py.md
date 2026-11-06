# Technical Design: `tools/update_wbs_ats207.py`

Source: `tools/update_wbs_ats207.py`

Source-SHA256: `b9d88bf1c67f8770ebdd89f0484ced8a4516ffd00182dbcbeb03ccb719a55cb2`

## Responsibility

Synchronises the ATS-207 row of `docs/WBS.xlsx` (sheet 开发WBS) with the delivery of the single-instance lock and crash recovery. It also refreshes the cached totals and the shared narrative cells of the 总览 sheet. The workbook is patched surgically, in the pattern of `tools/update_wbs_ats401.py` / `tools/update_wbs_ats506.py`:
- the sheet XML is edited in place;
- every other zip member is rewritten byte-for-byte with its order and timestamp;
- openpyxl never saves the file.

## Dependencies

- Upstream: `tools/wbs_common.py` (`SHEET1`, `SHEET2`, `cell_text`, `cell_number`, `format_rate`, `set_cell_in_row`, `set_marked_cell`, `set_narrative_cell`, `totals`); the standard library modules `argparse`, `re`, `shutil`, `sys`, `zipfile` and `pathlib`.
- Downstream: `docs/WBS.xlsx`; `tools/test_update_wbs_ats207.py`; `tools/test_wbs_common.py` (requires the marker to be registered in `MARKERS`).

## Public Contract

- `python tools/update_wbs_ats207.py [--status 待审核|进行中] [--xlsx PATH]`.
  - `--status` defaults to 待审核.
  - `--xlsx` defaults to the repository workbook.
  - Returns 0 and prints `updated <path>`.
- Row ATS-207:
  - N becomes the given status.
  - O becomes 1 for 待审核 and 0.6 for 进行中.
  - P is the cached `K*(1-O)` computed from the row's own estimate. The formula is kept.
  - T gets the `【ATS-207】` note. Foreign marked blocks in the cell survive.
  - A row that is already 已完成 or 已取消 keeps N/O/P, so the updater never downgrades an accepted row. Only its note is refreshed.
- 总览:
  - B8/B9/B10 are recomputed from the sheet with `totals`.
  - D6/D7 are recomposed from every task's fragment with `set_narrative_cell`.
- `find_ats_row(xml, ats_id)` returns the row number. It raises `SystemExit` when the row is missing.
- Invariants:
  - running the script twice gives byte-identical sheets (idempotent);
  - the note is XML-escaped by `wbs_common`, so the workbook stays parseable by openpyxl;
  - 待审核 is never 已完成: the reviewer syncs acceptance.

## Change Notes

This is a new updater for ATS-207. The marker `【ATS-207】` and its D6/D7 narrative fragments are registered in `tools/wbs_common.py`.
