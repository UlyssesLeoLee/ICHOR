# Technical Design: `tools/update_wbs_ats307.py`

Source: `tools/update_wbs_ats307.py`

Source-SHA256: `3e351cb9ce7e57ccc9ae67aae16d6c9f199fb4828519e7ec379ee077184f1a3c`

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

Every MEASURED number the note carries is DERIVED from a committed evidence
log. The script never types a count of its own: a re-typed constant is what
lets the workbook claim a figure that no committed log carries.

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
- `regression_figures(log_path)` / `suite_figures()` / `graph_figures(log_path)`:
  the three derivation functions. Each one either returns the figures it read
  from a committed log, or raises `SystemExit` naming the log it could not
  read. None of them has a fallback value.
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

### The suite's case counts are DERIVED too — the same defect class

Deriving the REGRESSION figures while typing the SUITE's case count by hand is
the same defect wearing a different hat. The suite grew (the `failed` state
added three cases), the typed count stayed, and the workbook, the design
document and the evidence README then all claimed a case count that the
committed suite log contradicted — the log was sitting in the same directory.

⇒ `suite_figures()` reads the committed suite logs
(`docs/evidence/ATS-307/01-node-test-traceability-ut.log` and
`.../02-node-test-traceability-it.log`) and returns the `tests` / `pass` /
`fail` / `skipped` counts of each. A log that is missing or does not carry the
four lines is a hard error, exactly as for the regression log.

⇒ The note's suite counts are written from those figures, and `verify()`
asserts that the note carries them. The note can therefore no longer name a
case count that the committed suite log contradicts.

⇒ `suite_figures()` also returns the LIST of the case ids the suite log names,
so the note can name the cases it added and the verification can assert that
the ids the note names are ids the log actually shows.

### The updater can be exercised on a copy

`--xlsx PATH` was missing, so the updater could only write the repository
workbook. A test of it would therefore have MODIFIED the deliverable while
"passing" — the symptom is a test that reports success while another file
changed. Every function that touches the workbook now takes the path.

### The negative control's MUTATION COUNT is derived too — the same defect class

The note stated "4 mutations". The negative control performed FIVE: the
commit-propagation mutation (AC-3) was added to the probe, and the count in
the note, in the evidence README and in the design document was not
refreshed. The count a reader trusts was the stale one, and the log that
contradicted it was in the same directory.

⇒ `mutation_figures()` reads the committed negative-control log
(`docs/evidence/ATS-307/05-negative-control.log`) and counts its numbered
group headers. Group 0 is the POSITIVE control (the intact graph), so the
mutations are the groups after it. A log that is missing, or that carries
no group header, is a hard error, exactly as for the other logs.

⇒ The note's mutation count is written from that figure, and `verify()`
asserts the note carries it — so a mutation added to the probe without the
note being regenerated is caught instead of silently shipped.

### The evidence README's log table was NOT covered by the consistency check

The README's table row for the full regression stated `1902 tests / 1870
pass` while the log it names said `1953 tests / 1921 pass`. The consistency
check compared the UT/IT case counts against their suite logs, but the full
regression's row — the one row that states a whole suite's counts — was
never compared against the log it names.

⇒ `tools/ats307-probes/check-readme-consistency.mjs` now compares the
README's full-regression row against the committed log's four summary lines,
and the README's negative-control mutation count against the negative
control log's group headers.

### The DESIGN DOCUMENT's measurements were typed, and nothing checked them

The design document's §10 table and its AC-3 row quoted the graph's shape
(nodes, edges, chains, commit coverage). Nothing compared them with the
probe log, so the design document could keep quoting an earlier tree's
graph while its acceptance table said `IMPLEMENTED`. The design document
is where a reviewer reads the acceptance criteria, so a stale number there
is worse than one in the README.

⇒ The consistency check now compares the design document's §10 table and
its AC-3 row against the committed probe log's measurements. A stale number
in the acceptance document is now a red gate, not a discrepancy a reader has
to notice.

### The note no longer carries review-process narration

The note describes what was delivered and what was measured. It does not
describe the review rounds: a note that says "round 3" is a log, and a log
goes stale the moment the next task reads it.
