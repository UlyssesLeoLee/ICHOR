# Technical Design: `apps/studio/app/page.tsx`

Source: `apps/studio/app/page.tsx`

Source-SHA256: `395491a9648649eef679b46fe7d27febccfdfe78e1e8d5dc2b366bf2691233ca`

## Responsibility

The Next.js workbench: the App Router page of `apps/studio`. It renders the
catalogue, the run list, the evidence workbench and the credential panel, and
it owns the DOCUMENT-level keyboard commands (Escape / Enter / Ctrl+Enter /
Ctrl+P) that ATS-111's acceptance criterion is about.

The rules this file owns, and that the review rounds have found broken three
times, are:

1. **the four states are distinguishable** — empty / failed / cancelled /
   loading — rendered from the model in `apps/studio/lib/workbench-state.mjs`;
2. **the core flow is keyboard-completable** — no `click()` on the workbench's
   own controls;
3. **the catalogue is cleared on a project switch** — the previous project's
   cases must not stay in the panel, in the 「可管理用例」 metric or in the
   footer while the new project loads;
4. **a failed run POLL is reported** — the rows below it are the last known
   ones and are marked stale;
5. **a control with its own Enter action keeps it** — focusing 「取消」 and
   pressing Enter cancels; it must not add the project.

## Dependencies

- Upstream: `apps/studio/lib/workbench-state.mjs` (the four states, the
  keyboard model, `escapeTarget`, `keyCommandFor`, `hasNativeEnterAction`),
  `apps/studio/lib/api.ts` (the API client, `cancellableApi`), and the shared
  modules under `apps/studio/public/` that the portable UI imports too.
- Downstream: `apps/studio/public/fallback.html` (the portable UI), the
  ATS-111 system test `tools/ats111-probes/st-ats111.mjs`, the ATS-111
  mutation probe `tools/ats111-probes/mutation-check.mjs`, the ATS-214
  system test `tools/ats214-probes/st-ats214.mjs`, and
  `docs/16-BASELINE-ADR.md` §3.1 (which pins the workbench footer's
  `file:line` position and is validated by the ATS-101 port audit).

## Public Contract

- The workbench footer carries the port text `LOCAL RUNNER · 127.0.0.1:<port>`
  on the line `docs/16-BASELINE-ADR.md` §3.1 names. **The line count of this
  file therefore matters**: a change that moves the footer moves the ADR's
  pinned position, and the ATS-101 port audit compares the source's runtime
  positions against the ADR's list BY POSITION.
- The keyboard commands are bound to the DOCUMENT, not to the app shell: the
  focus is not always inside the shell.
- Escape acts on the NESTED target — dialog, then load, then run — innermost
  first.
- A control with its own Enter action (`<button>`, `<a href>`, `<summary>`,
  an `<input>` of type button/submit/reset, a contenteditable) keeps it: the
  workbench does not perform a different write on top of it.

## Change Notes

**Three regressions were restored, and one comment was corrected.**

The tree this round started from had lost three of the behaviours above, and
each loss was a REGRESSION against `3a00702` (the tree the round-3 review
accepted) rather than a defect that had always been there:

| # | What was lost | How it showed | Fix |
|---|---|---|---|
| 1 | the catalogue is NOT cleared on a project switch | the previous project's cases stayed in the panel, in the metric and in the footer while the new project loaded | `setCatalog(...)` before the request goes out |
| 2 | a failed run POLL is not reported | `runsRequest.phase` stayed `settled`, so the runs panel kept saying 「就绪」 and the stale rows were not marked | the poll's `.catch` records the failure instead of discarding it |
| 3 | the `hasNativeEnterAction` guard was dropped from the submit handler | focusing 「取消」 and pressing Enter ADDED A PROJECT instead of cancelling it | the guard is back |
| 4 | two close paths bypassed `closeDialog()` | the 「取消」 button and the overlay click called `setDialog(false)`, so the focus was NOT restored — it stayed on the `<body>` | both call `closeDialog()` |

The losses came in with a dev merge into the ATS-214 branch (`ab22833a`),
which is how ATS-111's lines were dropped: the import of
`hasNativeEnterAction` was still there, but the CALL was gone — which is
exactly the shape of a silent regression.

The fifth change is a COMMENT: the note on `addProjectRef` claimed the focus
returns to "the control that OPENED the add-project dialog". It does not: the
ref is bound to the project bar's 「添加项目」 button, `closeDialog` focuses it
unconditionally, and the dialog is also opened from the no-project panel and
from the welcome screen. The comment now says what the code does, and points
at `closeDialog` for the rule.
