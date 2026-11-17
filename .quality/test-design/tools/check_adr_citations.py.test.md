# Test Design: `tools/check_adr_citations.py`

Source: `tools/check_adr_citations.py`

Source-SHA256: `d390fb258c60081932c1258db27774f2622600ef5db5cc3654c10d410c04a60c`

## Test Strategy

pytest tests in `tools/test_check_adr_citations.py`. The module is a
SCRIPT (no `main(argv)` seam — it reads `ROOT` and `ADR` from module scope), so
the tests drive it as a subprocess against a COPY of the tree, exactly the way
the ATS-301 gate invokes it. Each test builds a temporary repository layout
(a fake `docs/16-BASELINE-ADR.md` plus the source files the ADR cites), runs
`python tools/check_adr_citations.py` in it, and asserts on the exit code and
the printed result.

The fixtures copy the REAL needles out of the real tree, so a change to the
real source that moves a needle would break the fixture and be reported rather
than silently papered over.

Two properties are checked in BOTH directions:

- a citation that resolves must make the run print `RESULT: OK` and exit 0;
- a citation that does NOT resolve must make the run print `RESULT: MISMATCH`,
  exit 1, and name the offending file and position.

The second direction is the one that makes the first meaningful: a checker
that cannot fail proves nothing.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | A tree whose ADR cites a `server/index.mjs` position that holds the `const PORT=Number(process.env.ATS_PORT\|\|` needle | exit 0, `RESULT: OK` | `tools/test_check_adr_citations.py` |
| TC-002 | The same tree, but the cited `server/index.mjs` position shifted by one line | exit 1, `RESULT: MISMATCH`, the output names the cited position | `tools/test_check_adr_citations.py` |
| TC-003 | A tree whose ADR cites an `apps/studio/app/page.tsx` position that holds the `LOCAL RUNNER · 127.0.0.1:` needle | exit 0, `RESULT: OK` | `tools/test_check_adr_citations.py` |
| TC-004 | A tree whose `apps/studio/app/page.tsx` holds the footer needle on a DIFFERENT line than the ADR cites | exit 1, `RESULT: MISMATCH` — the port-audited position is derived, so the stale hand-written position can no longer mask the move | `tools/test_check_adr_citations.py` |
| TC-005 | A tree whose ADR cites a file that no checker covers at all | exit 1, `RESULT: MISMATCH`, the output says the file is cited but no checker covers it | `tools/test_check_adr_citations.py` |
| TC-006 | A tree whose ADR cites a RANGE that does not start on the range anchor | exit 1, `RESULT: MISMATCH`, the output names the range | `tools/test_check_adr_citations.py` |
| TC-007 | A tree whose ADR cites a port-audited position that the ADR does not mention | exit 1, `RESULT: MISMATCH`, the output says the position is port-audited but not cited | `tools/test_check_adr_citations.py` |
| TC-008 | The real repository itself | exit 0, `RESULT: OK` — the derivation finds the real port positions and the real ADR cites exactly those | `tools/test_check_adr_citations.py` |
| TC-009 | The real repository's `PORT_AUDITED` table, asked for the derived position of each entry | every derived position is the line that actually holds the port, and every one of them is cited by the real ADR | `tools/test_check_adr_citations.py` |

## Boundary & Failure Cases

- A needle that is NOT in the source yields NO derived position. The script
  then reports the construct as gone rather than pointing at a wrong line.
- A file that holds the same needle on SEVERAL lines must not derive an
  arbitrary one: each of the four `apps/studio/lib/api.ts` branches has its
  own distinct needle, so the derivation is unambiguous. TC-009 asserts that
  the four derived positions are four DIFFERENT lines.
- A missing source file is reported (`the file does not exist`), never
  silently skipped.
- A malformed citation spec (`52-`, `12,,14`) is reported as a malformed spec
  with the offending spec named, not raised as a traceback.
- The script must not WRITE: the ADR and the source files must be byte-identical
  after a run.

## Regression Scope

`bash tools/ats301-probes/check-ats301-gate.sh` runs this script as step 2 of
the ATS-301 gate, together with `tools/test_wbs_common.py` and the ATS-101
port audit. The gate must print `RESULT: OK` on the merged tree. The port
audit (`tools/ats101-probes/scenario-d-port-audit.mjs`) is the authority on
WHICH positions are runtime port hardcodings; this script and the audit must
agree on the positions of the four port-bearing files, or one of them reports a
mismatch. `docs/16-BASELINE-ADR.md` §3.1 must stay in step with the source, so
`python tools/fix_baseline_adr_refs.py` remains the way to re-point the
citations after a source change.
