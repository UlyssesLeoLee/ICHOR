# Test Design: `apps/studio/app/page.tsx`

Source: `apps/studio/app/page.tsx`

Source-SHA256: `395491a9648649eef679b46fe7d27febccfdfe78e1e8d5dc2b366bf2691233ca`

## Test Strategy

The workbench is a React page, so the behaviour is asserted in a REAL browser
against the REAL static export: `tools/ats111-probes/st-ats111.mjs` drives it
with the keyboard alone (no `click()` on the workbench's own controls), with a
real Bridge, real Playwright and real Chromium behind it.

Each of the four regressions this round restored has its own check, and each
check is **falsifiable**: it asserts an outcome that a broken implementation
cannot produce.

| Regression | The check | Why it cannot pass on a broken build |
|---|---|---|
| the catalogue is not cleared on a project switch | ST-111-13b/c/d | the panel, the metric and the footer are read while the new project's request is HELD open, so the old project's cases would still be counted |
| a failed run poll is not reported | ST-111-19b/c/d | the probe fails the poll with a 500 and reads the panel's `data-runs-state` and the rows' `data-stale` |
| the `hasNativeEnterAction` guard is dropped | ST-111-11d | the probe types a path that has NEVER been registered, so a wrong submission raises the project count |
| a close path bypasses `closeDialog()` | ST-111-15 | the probe cancels the dialog with the keyboard and reads `document.activeElement` |

The probe's own correctness is asserted by the mutation probe
(`tools/ats111-probes/mutation-check.mjs`), which breaks the model and the
view wiring in 25 ways and requires every one of them to turn the suite RED.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | The catalogue load is switched to another project while the request is held open | the panel, the 「可管理用例」 metric and the footer show NONE of the previous project's cases | `tools/ats111-probes/st-ats111.mjs` |
| TC-002 | The run poll is failed with a 500 | the runs panel's `data-runs-state` is `error`, every run row carries `data-stale="true"`, and the panel carries the `data-region="runs-stale"` note | `tools/ats111-probes/st-ats111.mjs` |
| TC-003 | The poll works again | the stale marks and the note are gone | `tools/ats111-probes/st-ats111.mjs` |
| TC-004 | The 「取消」 button is focused with the keyboard and Enter is pressed | the dialog closes and the NEVER-REGISTERED project is NOT registered (the count is unchanged) | `tools/ats111-probes/st-ats111.mjs` |
| TC-005 | The dialog is closed with the keyboard | the focus is on the 「添加项目」 button (`data-region="add-project"`), not on the `<body>` | `tools/ats111-probes/st-ats111.mjs` |
| TC-006 | The Tab walk over the whole workbench | the regions are visited in the model's `FOCUS_ORDER`, and the model declares every region the markup carries | `tools/ats111-probes/st-ats111.mjs` |
| TC-007 | The model unit tests | every declared region has a landmark role, and the focus order is the declared one | `tests/workbench-state.test.mjs` |
| TC-008 | The control build | the system test is GREEN on the unmutated tree | `tools/ats111-probes/mutation-check.mjs` |

## Boundary & Failure Cases

- **The focus must be RESTORED, not merely present.** ST-111-15 reads
  `document.activeElement` and requires the 「添加项目」 button: a build that
  closes the dialog and leaves the focus on the `<body>` fails it, which is
  what the regression did.
- **The counter must have an input nobody used.** TC-004 types a path that has
  never been registered, so the Bridge does not reject it as a duplicate — the
  count really moves if the form is submitted.
- **The request must be HELD, not merely slow.** TC-001 holds the request
  open in the route handler, so the panel is caught in the state that shows
  the stale rows. A slow-but-completing request would pass by accident.
- **The probe has to work against TWO shapes of the catalogue row.** The
  falsifiability step copies this probe onto the two pinned baseline trees:
  on the baselines the ROW was the `<button>`, today the row is a `<div>` and
  its TITLE is the button. A selector that matched only one shape would fail
  on a baseline because the element was missing, not because of the defect.
- **A held request must be RELEASED.** The route handler holds a LIST of
  resolvers, not one: `reloadCatalogue` fires two requests, and with a single
  slot the second overwrote the first — leaving one request hanging forever
  and the panel stuck in 「加载中」 for the rest of the run.

## Regression Scope

The whole ATS-111 suite (79 checks), the ATS-111 mutation probe (25
mutations), the ATS-214 suite (its ST drives the same catalogue rows, so the
row's markup shape matters to it too), and the ATS-301 gate (the ADR's
`file:line` position for the workbench footer moves with this file's line
count, and the ATS-101 port audit validates that position against the source
by position).
