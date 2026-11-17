# Test Design: `tools/update_wbs_ats307.py`

Source: `tools/update_wbs_ats307.py`

Source-SHA256: `0c151dba79aa91c9b7987d66cbd12e31019ae751a698893a1f9587b349d29923`

## Test Strategy

pytest tests in `tools/test_update_wbs_ats307.py`. Each test copies the
committed `docs/WBS.xlsx` into a pytest `tmp_path` and runs the updater
against the COPY (`--xlsx`), so the repository workbook is never touched and
the coverage is attributed to the real module.

The tests that concern the note's numbers read the committed evidence log
`docs/evidence/ATS-307/06-node-test-full.log` — the same file the updater
reads — and assert that the numbers the note carries are exactly the ones the
log carries. A fixture that hard-codes "1865" would pass forever; a fixture
that reads the log fails the moment the two disagree, which is the defect this
round is about.

Two properties are checked in BOTH directions:

- the happy path must produce the expected row;
- the guard must FIRE — a missing log must make the updater refuse to write,
  and a log with a wrong number must make the self-check fail.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | Copy of the workbook; `main(['--xlsx', copy])` | ATS-307 row: N=`待审核`, O=`1`, P=`0`; T holds exactly one `【ATS-307】` marker and the `追溯链` scope | `tools/test_update_wbs_ats307.py` |
| TC-002 | `main(['--xlsx', copy, '--status', '已完成'])` | N=`已完成` (the status the reviewer writes after a PASS) | `tools/test_update_wbs_ats307.py` |
| TC-003 | Run TC-001 twice on the same copy | the second run leaves the file byte-identical | `tools/test_update_wbs_ats307.py` |
| TC-004 | Seed N=`已完成` with O=`1` and P=`0` in the ATS-307 row of the copy, then run | N stays `已完成` — an accepted row is not downgraded | `tools/test_update_wbs_ats307.py` |
| TC-005 | Copy whose ATS-307 T cell holds a foreign `【ATS-307】`-neighbour block | after the run both blocks are present and the foreign one is byte-identical | `tools/test_update_wbs_ats307.py` |
| TC-006 | After the run | 总览 B8/B9/B10 equal `totals(parts)`; D6/D7 hold every task's fragment | `tools/test_update_wbs_ats307.py` |
| TC-007 | After the run | every zip member except sheet1/sheet2 is byte-identical to the input; no `.bak` beside the copy; rows other than ATS-307 unchanged | `tools/test_update_wbs_ats307.py` |
| TC-008 | The note in the written cell | its regression figures are EXACTLY the `ℹ tests` / `ℹ pass` / `ℹ fail` / `ℹ skipped` values of `docs/evidence/ATS-307/06-node-test-full.log` | `tools/test_update_wbs_ats307.py` |
| TC-009 | A copy, and a temporary tree whose evidence log has been replaced by one whose `ℹ pass` line says a different number | the self-check FAILS and the run exits non-zero, naming the log | `tools/test_update_wbs_ats307.py` |
| TC-010 | A temporary tree with no `docs/evidence/ATS-307/06-node-test-full.log` | the updater REFUSES to write (non-zero exit, message naming the log) and the workbook is left untouched | `tools/test_update_wbs_ats307.py` |
| TC-011 | `main(['--status', 'not-a-status'])` | argparse error, exit 2 | `tools/test_update_wbs_ats307.py` |
| TC-012 | `find_ats_row` on XML without the ID | `SystemExit` naming the ID | `tools/test_update_wbs_ats307.py` |
| TC-013 | `main(['--verify-only', '--xlsx', copy])` | verifies the row and the note against the evidence log without writing | `tools/test_update_wbs_ats307.py` |

## Boundary & Failure Cases

- The evidence log is the ONLY source of the note's numbers: a log that
  carries `ℹ pass` but not `ℹ skipped` must make the updater refuse to write,
  not write a note with a partial set of figures.
- A note whose numbers are correct but whose marker is doubled must fail the
  verification (the marker appears exactly once).
- The note must not carry review-process narration: the verification asserts
  that the note holds no `第 N 轮` / `驳回` / `复核只剩` phrasing, because such
  a note is a log and it goes stale as soon as the next task reads it.
- The updater writes the repository workbook only when `--xlsx` is absent;
  every test passes `--xlsx`, so the deliverable is never modified by a test.
- `os.replace()` can fail on Windows when the target is held open, so the
  rewrite uses `shutil.copy2` + `unlink` (the same shape as the other
  updaters).
- A workbook whose ATS-307 row contradicts itself (N=`已完成` but O<1) is a
  stale artefact, not an acceptance, and does not veto the status this task
  owns.

## Regression Scope

`tools/test_wbs_common.py` must pass (the `【ATS-307】` marker is registered in
`wbs_common.MARKERS`, and the declared marker set equals `MARKERS`).
`bash tools/ats501-probes/check-wbs-updaters.sh` must pass with this updater
discovered — it checks coexistence, order independence and idempotence of all
the updaters against the SHARED workbook, which is where a note that loses a
foreign marked block would show up. `docs/evidence/ATS-307/06-node-test-full.log`
is the input the note's numbers are derived from, so re-collecting the evidence
without re-running the updater would leave the note stale — the derivation
makes that a visible mismatch rather than a silent one.
