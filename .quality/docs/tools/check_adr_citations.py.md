# Technical Design: `tools/check_adr_citations.py`

Source: `tools/check_adr_citations.py`

Source-SHA256: `d390fb258c60081932c1258db27774f2622600ef5db5cc3654c10d410c04a60c`

## Responsibility

Validate every `path:line` citation that `docs/16-BASELINE-ADR.md` carries against
the current source tree. The script enumerates every citation the ADR holds and
then checks each one:

- a POSITION citation (`server/index.mjs:194`) is checked against the needle the
  ADR's sentence implies;
- a RANGE citation (`server/index.mjs:1350-1380`) is checked as a whole — the
  range's start must hold the construct's anchor and its end must be the
  construct's extent;
- a citation that no checker covers is reported as UNCOVERED and fails the run,
  so the script can never claim to have checked "every citation" while checking
  only a hand-picked subset.

The RUNTIME port citations are covered by the ATS-101 port audit
(`tools/ats101-probes/scenario-d-port-audit.mjs`), which validates them BY
POSITION against the source. That exemption is granted per POSITION, not per
FILE: a citation of a different line of an audited file is not covered and has to
carry a needle here.

## Dependencies

- Upstream: Python standard library `re`, `sys`, `pathlib`. The ADR document
  `docs/16-BASELINE-ADR.md` and the audited source files it cites.
- Downstream: `bash tools/ats301-probes/check-ats301-gate.sh` (step 2 of the
  ATS-301 gate), and `tools/ats101-probes/scenario-d-port-audit.mjs` (the two
  scripts together decide whether the ADR's port list still matches the tree).

## Public Contract

- CLI: `python tools/check_adr_citations.py`. Exit 0 and prints `RESULT: OK`
  when every citation resolves; exit 1 and prints `RESULT: MISMATCH` plus one
  indented line per failure otherwise.
- `EXPECTED_NEEDLES`: `file -> [needle, ...]`. The POSITIONS are DERIVED from
  the source at run time (the first line that holds the needle), never written
  down — a written-down position goes stale whenever the cited file is
  rewritten, and a stale entry turns the gate RED for a bookkeeping reason
  that has nothing to do with the code.
- `EXPECTED`: `file -> {position: needle}`. The literal entries keep their
  positions because their files are not rewritten by the tasks that touch the
  bridge.
- `RANGES`: `[(file, start anchor needle, description), ...]`. The range's END
  is READ FROM THE ADR TEXT, never hardcoded here.
- `PORT_AUDITED`: `file -> {position: what the position is}`. The positions the
  ATS-101 port audit validates. Step 5 checks that each exempted position is
  actually cited by the ADR — a position the audit validates but the ADR does
  not mention would make the audit's guarantee vacuous.
- Invariants: the script only READS; it never writes the ADR or the source. A
  citation whose construct is gone is reported, never invented.

## Change Notes

**The port-audited positions are derived from the source, not written down.**

`PORT_AUDITED` used to hold literal positions (`apps/studio/app/page.tsx` at
1080, `apps/studio/lib/api.ts` at 106/109/111/115, `src-tauri/src/lib.rs` at
45). Those files are rewritten by the front-end and desktop tasks, and every
rewrite moved the port line without updating this table. The failure mode is
silent in the source and loud in the gate: step 5 reports
`STALE <file>:<n> (port-audited but not cited by the ADR)` because the ADR
cites the NEW position while the table still holds the OLD one. Measured on the
pre-merge baseline `dfc2dab`: the ATS-301 gate was ALREADY RED for exactly this
reason, before the traceability work merged.

⇒ `PORT_AUDITED` now maps `file -> {needle: what the position is}` and the
position is DERIVED the same way `EXPECTED_NEEDLES` derives its positions: the
first line of the file that holds the needle. The needle for each file is the
text that identifies the port-bearing line without spelling out the port
number (the port audit scans every source file for the hardcoded port, so a
needle that spelled it out would make this checker look like a seventh runtime
site and break the audit):

| file | needle |
|---|---|
| `apps/studio/lib/api.ts` | the four `return 'http://127.0.0.1:` branches — each is distinguished by the branch that precedes it |
| `apps/studio/app/page.tsx` | `LOCAL RUNNER · 127.0.0.1:` |
| `apps/studio/public/fallback.html` | `LOCAL BRIDGE · 127.0.0.1:` |
| `src-tauri/src/lib.rs` | `.env("ATS_PORT","` |

The `apps/studio/lib/api.ts` positions are the one case where a single needle
does not identify the line: all four branches hold the same text. They are
therefore given four DISTINCT needles, each naming the branch that decides it
(`typeof window==='undefined'`, `port==='3000'`, `protocol==='tauri:'`, and the
final `return`), so every derived position is unambiguous.

The derivation keeps the checker's strength: the ADR still cites a position and
the script still checks THAT position against the needle, so a citation that
points at the wrong line is still caught ("the line the ADR cites holds this
needle", not "this line number holds this needle"). What changes is that a
file rewrite no longer needs a hand edit here — and the port audit, which
compares the source's runtime positions against the ADR's list by position,
remains the authority on WHICH positions are port hardcodings.
