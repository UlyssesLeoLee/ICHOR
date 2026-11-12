# Technical Design: `tools/update_wbs_ats104.py`

Source: `tools/update_wbs_ats104.py`

Source-SHA256: `6c96176a9bc560db7c838705a538848233979b007675776aebea563c72a0ca41`

## Responsibility

Synchronises the ATS-104 row of `docs/WBS.xlsx` (sheet 开发WBS) with the delivery of
the Tauri 2 Windows dev build and the WebView2 shell, and refreshes the cached totals
and the shared narrative cells of the 总览 sheet. The workbook is patched surgically,
in the pattern of `tools/update_wbs_ats214.py`:

- the sheet XML is edited in place;
- every other zip member is rewritten byte-for-byte with its order and timestamp;
- openpyxl never saves the file.

## Dependencies

- Upstream: `tools/wbs_common.py` (`SHEET1`, `SHEET2`, `cell_text`, `format_rate`, `set_cell_in_row`, `set_marked_cell`, `set_narrative_cell`, `totals`); the standard library modules `argparse`, `re`, `shutil`, `sys`, `zipfile` and `pathlib`.
- Downstream: `docs/WBS.xlsx`; `tools/test_wbs_common.py` (requires the marker to be registered in `MARKERS`); `tools/ats501-probes/check-wbs-updaters.sh` (the coexistence regression discovers every `tools/update_wbs_ats*.py`).

## Public Contract

- `python tools/update_wbs_ats104.py [--verify-only] [--status 待审核|已完成]`.
  - `--status` defaults to 待审核.
  - `--verify-only` checks the row and the workbook's parseability without writing.
  - Returns 0 and prints `updated <path>`.
- Row ATS-104 (row 9):
  - N becomes the given status.
  - O becomes 1.
  - P is the cached `K*(1-O)` = 0. The formula is kept.
  - T gets the `【ATS-104】` note. Foreign marked blocks in the cell survive.
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

The note records the delivery of the Tauri 2 Windows dev build: the two build-side
defects that were fixed (the missing `src-tauri/icons/icon.ico`, and the `cdylib`
crate type whose PE export table exceeded the ordinal limit) and the one runtime-side
defect that was fixed (the Bridge child outliving the closed window because the
Windows event loop exits through `std::process::exit`, which runs no destructor). It
also states the boundary that was NOT verified: the msvc chain's final link, because
this machine has no MSVC C++ build tools workload.
