# Technical Design: `tools/update_wbs_ats506.py`

Source: `tools/update_wbs_ats506.py`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Responsibility

Synchronise `docs/WBS.xlsx` with the ATS-506 delivery by a surgical edit of the workbook XML (no openpyxl, no rebuild), following the convention of the other `tools/update_wbs_*.py` updaters so that the shared workbook can be regenerated after any merge:

- 开发WBS (sheet2), ATS-506 row: 状态 N (default `待审核`, `进行中` during a rework round), 完成率 O (`1` when submitted, `0.6` while in progress), 剩余人日 P cached value = K × (1 − O) read from the row's own estimate (the formula is kept), and the 风险/说明 T cell gets this script's `【ATS-506】` marked note while foreign marked notes (e.g. `【ATS-501】`) survive.
- 总览 (sheet1): cached values of B8/B9/B10 derived from the sheet just written, and the shared narrative cells D6/D7 recomposed from every task's fragment.
- A row already accepted (`已完成` / `已取消`) is never downgraded.

## Dependencies

- Upstream: `tools/wbs_common.py` (`SHEET1`, `SHEET2`, `cell_text`, `cell_number`, `format_rate`, `set_cell_in_row`, `set_marked_cell`, `set_narrative_cell`, `totals`), Python standard library `argparse`, `re`, `shutil`, `zipfile`, `pathlib`.
- Downstream: `docs/WBS.xlsx`; `tools/ats501-probes/check-wbs-updaters.sh` discovers it through `tools/update_wbs_*.py` and checks coexistence; `tools/ats506-probes/collect-evidence.sh` runs it; `tools/test_wbs_common.py` checks that its marker is registered in `wbs_common.MARKERS`.

## Public Contract

- CLI: `python tools/update_wbs_ats506.py [--status {待审核,进行中}] [--xlsx PATH]`; default status `待审核`, default workbook `docs/WBS.xlsx`. Any other status is rejected by argparse (exit 2). Prints `updated <path>`.
- `update(xlsx_path, status) -> None`: performs the edit in place; every zip member other than sheet1/sheet2 is rewritten with identical bytes and the same member order and timestamps.
- `find_ats_row(xml, ats_id) -> int`: row number of the WBS ID; `SystemExit` when absent.
- `main(argv=None) -> int`: parses arguments, calls `update`, returns 0.
- Invariants: idempotent (a second run with the same status leaves the file byte-identical); no `.bak` file is produced; only the ATS-506 row and the 总览 cells B8/B9/B10/D6/D7 change.

## Change Notes

New script for ATS-506. It does not annotate other rows: the downstream constraints on ATS-507/509/511 are carried by the ATS-501 updater's notes and by `docs/21-CONTROL-PLANE-API.md`.
