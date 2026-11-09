# Technical Design: `tools/update_wbs_ats107.py`

Source: `tools/update_wbs_ats107.py`

Source-SHA256: `6bbc8b008f2f10edc504b15c71499a3e37de1355b3635e3d37278510ce1fee05`

## Responsibility

Synchronises the ATS-107 row of `docs/WBS.xlsx` (sheet 开发WBS) with the delivery of the real-browser PASS/FAIL test repository and its regression fixture. It also refreshes the cached totals and the shared narrative cells of the 总览 sheet. The workbook is patched surgically, in the pattern of `tools/update_wbs_ats106.py` / `tools/update_wbs_ats207.py`:

- the sheet XML is edited in place;
- every other zip member is rewritten byte-for-byte with its order and timestamp;
- openpyxl never saves the file.

## Dependencies

- Upstream: `tools/wbs_common.py` (`SHEET1`, `SHEET2`, `cell_text`, `cell_number`, `format_rate`, `set_cell_in_row`, `set_marked_cell`, `set_narrative_cell`, `totals`); the standard library modules `argparse`, `re`, `shutil`, `sys`, `zipfile` and `pathlib`.
- Downstream: `docs/WBS.xlsx`; `tools/test_update_wbs_ats107.py`; `tools/test_wbs_common.py` (requires the marker to be registered in `MARKERS`); `tools/ats501-probes/check-wbs-updaters.sh` (the coexistence regression discovers every `tools/update_wbs_ats*.py`).

## Public Contract

- `python tools/update_wbs_ats107.py [--status 待审核|进行中] [--xlsx PATH]`.
  - `--status` defaults to 待审核.
  - `--xlsx` defaults to the repository workbook.
  - Returns 0 and prints `updated <path>`.
- Row ATS-107:
  - N becomes the given status.
  - O becomes 1 for 待审核 and 0.6 for 进行中.
  - P is the cached `K*(1-O)` computed from the row's own estimate. The formula is kept.
  - T gets the `【ATS-107】` note. Foreign marked blocks in the cell survive.
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

This is a new updater for ATS-107. The marker `【ATS-107】` and its D6/D7 narrative fragments are registered in `tools/wbs_common.py`.
