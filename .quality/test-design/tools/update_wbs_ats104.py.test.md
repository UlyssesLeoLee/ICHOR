# Test Design: `tools/update_wbs_ats104.py`

Source: `tools/update_wbs_ats104.py`

Source-SHA256: `6c96176a9bc560db7c838705a538848233979b007675776aebea563c72a0ca41`

## Test Strategy

The tests are pytest plus the repository's own WBS regression scripts. They never
write the repository workbook: every test edits a COPY under `tmp_path`, or runs the
updater's own idempotency check against a copy.

- `tools/test_wbs_common.py` runs the updater against a copy and asserts the
  row, the marker registration and the idempotency. It discovers every
  `tools/update_wbs_ats*.py`, so ATS-104 is covered by it automatically.
- `tools/ats501-probes/check-wbs-updaters.sh` runs EVERY updater in sequence against
  a copy and asserts they coexist: each is idempotent, none undoes an accepted
  review, and the 总览 cache always matches 开发WBS.
- openpyxl loads the result to prove it parses — a note written into the sheet XML
  without XML escaping makes the workbook unparseable while the updater still exits 0.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | the updater runs against a copy of the workbook | row ATS-104 (row 9) has N=待审核, O=1, P=0; T carries `【ATS-104】` exactly once and names `cargo tauri dev` | `tools/test_wbs_common.py` |
| TC-002 | the updater runs twice against the same copy | the second run leaves row ATS-104 byte-identical; the marker still appears once | `tools/test_wbs_common.py` |
| TC-003 | the marker of `tools/update_wbs_ats104.py` | exactly one marker is declared, and it is registered in `wbs_common.MARKERS` | `tools/test_wbs_common.py` |
| TC-004 | every `tools/update_wbs_ats*.py` runs in sequence against one copy | all of them coexist: 34 updaters, each idempotent, the 总览 cache matches 开发WBS after every step, and D6/D7 keep every task's contribution | `tools/test_update_wbs_ats104.py` |
| TC-005 | openpyxl loads the updated copy in the normal and the `data_only` mode | both load; the ATS-104 row is found; column P keeps its formula | `tools/test_update_wbs_ats104.py` |
| TC-006 | row ATS-104 pre-set to 已完成 / 1 / 0 (an accepted row), then the updater runs with 待审核 | N/O/P stay 已完成 / 1 / 0; the note is refreshed | `tools/test_wbs_common.py` |
| TC-007 | a foreign marked block already in T | the foreign block survives next to the ATS-104 block | `tools/test_wbs_common.py` |

## Boundary & Failure Cases

- **A row that is neither 待审核 nor 已完成** → `verify()` raises, so a wrong status
  cannot pass silently.
- **A row that says 已完成 but carries a completion rate below 1** → that row
  contradicts itself; it is a stale artefact, not an acceptance, and it does not veto
  the status this task owns, so the updater writes its own status.
- **The ATS-104 row is missing from the workbook** → `find_ats_row` raises
  `SystemExit`.
- **A note containing `<`, `>` or `&`** → escaped by `wbs_common` before it reaches
  the sheet XML; the workbook stays parseable. The ATS-104 note contains none of
  them, and the escaping is what keeps it that way.
- **The workbook is held open by another process** → `os.replace()` would fail on
  Windows; the updater copies the temporary file over the target and then unlinks
  the temporary one.
- **The updater is run after the review has returned PASS** → the row keeps 已完成
  across later runs (the review is a one-way door).

## Regression Scope

- `tools/wbs_common.py` — `MARKERS` (the canonical block order) and
  `NARRATIVE_FRAGMENTS` (the D6/D7 contributions). ATS-104's marker and its two
  fragments are registered there; a marker missing from `MARKERS` is invisible to
  the merge, which `tools/test_wbs_common.py` asserts against.
- `docs/WBS.xlsx` — the shared binary. Every other updater writes to the same
  workbook, so the coexistence regression is the real guard.
- `tools/update_wbs_ats*.py` — every other updater, for the same reason.

## Evidence

`docs/evidence/ATS-104/` — the WBS row and updater coexistence are covered by the
coexistence regression and by `tools/test_wbs_common.py`.
