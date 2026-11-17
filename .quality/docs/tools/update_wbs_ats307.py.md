# Technical Design: `tools/update_wbs_ats307.py`

Source: `tools/update_wbs_ats307.py`

Source-SHA256: `0c151dba79aa91c9b7987d66cbd12e31019ae751a698893a1f9587b349d29923`

## Responsibility

Synchronise the ATS-307 row of `docs/WBS.xlsx` with the delivered traceability
chain by a surgical edit of the workbook XML (no openpyxl rebuild), in the same
style as the other `tools/update_wbs_*.py` updaters:

- 开发WBS (sheet2), ATS-307 row: 状态 N (`待审核`, never `已完成` before the
  review passes), 完成率 O (`1`), 剩余人日 P (the cached value; the formula
  K×(1−O) is kept), and the 风险/说明 T cell gets this script's `【ATS-307】`
  marked note while foreign marked notes survive.
- 总览 (sheet1): the cached values of B8/B9/B10 are DERIVED from the sheet just
  written (`wbs_common.totals`), and the shared narrative cells D6/D7 are
  recomposed from every task's fragment.
- A row that has already been accepted (`已完成` / `已取消`) is never downgraded.

## Dependencies

- Upstream: `tools/wbs_common.py` (`SHEET1`, `SHEET2`, `cell_text`, `format_rate`,
  `set_cell_in_row`, `set_marked_cell`, `set_narrative_cell`, `totals`),
  Python standard library `argparse`, `re`, `shutil`, `zipfile`, `pathlib`.
- Downstream: `docs/WBS.xlsx`; `tools/test_wbs_common.py` checks that the
  `【ATS-307】` marker is registered in `wbs_common.MARKERS`;
  `tools/ats307-probes/collect-evidence.sh` runs the updater.

## Public Contract

- CLI: `python tools/update_wbs_ats307.py [--status STATUS] [--xlsx PATH]`.
  Default status `待审核`, default workbook `docs/WBS.xlsx`. Any other status is
  rejected by argparse (exit 2). `--xlsx PATH` edits the workbook at PATH
  instead of the repository one.
- `patch_workbook(status, xlsx_path)`, `row_signature(xlsx_path)`,
  `verify(xlsx_path)`, `check_parses(xlsx_path)`: every one of them takes the
  workbook path, so the updater can be exercised on a COPY and the repository
  workbook is never touched by a test.
- Invariants: idempotent (a second run with the same status leaves the file
  byte-identical); every zip member other than sheet1/sheet2 is rewritten with
  identical bytes, in the original member order and with the original
  timestamps; no `.bak` file is produced.

## Change Notes

### The measured numbers in the note are DERIVED, not written down

The note used to carry a hardcoded `1856 pass / 0 fail / 32 skipped`. The
committed evidence log says `1897 tests / 1865 pass / 0 fail / 32 skipped`, so
the note contradicted the log it was supposed to summarise. The number in the
note came from an EARLIER evidence commit and was never refreshed when the
evidence was re-collected — the hardcoded constant was the defect, not the
typo.

⇒ The note's regression figures are now read from the committed evidence log
`docs/evidence/ATS-307/06-node-test-full.log` at run time: the script parses
the `ℹ tests` / `ℹ pass` / `ℹ fail` / `ℹ skipped` lines and writes those
values into the note. If the log is missing or does not carry the four lines,
the updater REFUSES to write (it exits non-zero with a message naming the log)
rather than writing a note with no numbers in it.

⇒ The same derivation backs a self-check: after the note is written, the
script re-reads the cell and asserts that the four numbers in it are the ones
the log carries. A number that drifts can therefore no longer reach the
workbook.

⇒ The same check runs in `--verify-only` mode, so a reviewer can ask "does the
note still match the evidence?" without rewriting anything.

### The updater can be exercised on a copy

`--xlsx PATH` was missing, so the updater could only write the repository
workbook. A test of it would therefore have MODIFIED the deliverable while
"passing" — the symptom is a test that reports success while another file
changed. Every function that touches the workbook now takes the path.

### The note no longer carries review-process narration

The note describes what was delivered and what was measured. It does not
describe the review rounds: a note that says "round 3" is a log, and a log
goes stale the moment the next task reads it.
