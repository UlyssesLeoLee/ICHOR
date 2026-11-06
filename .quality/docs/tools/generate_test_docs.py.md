# Technical Design: `tools/generate_test_docs.py`

Source: `tools/generate_test_docs.py`

Source-SHA256: `16e5e6abdb779207b7a5fb457e564bc148b6dc48fca7e44b0ec29ae44fefac12`

## Responsibility

Single source of the UT/IT/ST test catalog. Running it regenerates `docs/07-UT-TEST-DESIGN.md`, `docs/08-IT-TEST-DESIGN.md`, `docs/09-ST-TEST-DESIGN.md`, `docs/10-RTM.md`, `tests/test-cases.json` and `tests/rtm.json` from the `UT`, `IT` and `ST` tuples, so the catalog, the traceability matrix and the machine-readable lists cannot drift apart.

## Dependencies

- Upstream: Python standard library `pathlib`, `json`, `re`; the catalog tuples in the file itself.
- Downstream: the six generated files above; `tools/ats101-probes/scenario-d-port-audit.mjs` (scans the file and its JSON output as non-runtime data); readers of `docs/10-RTM.md`.

## Public Contract

- Each catalog row is `(ID, requirement, category, title, input, expected, evidence, status)`; `status` is `PASS` only for an executed automated test, otherwise `PENDING`.
- ATS-207 adds UT-LOCK-001..015, UT-DATA-002..005, UT-WAL-001..004 (tests in `tests/instance-lock.test.mjs`) to `UT` and IT-LOCK-001..006, IT-DATA-001..002, IT-WAL-001..002 (tests in `tests/instance-lock-it.test.mjs`) to `IT`, linked to NFR-008 and NFR-010. UT-DATA-001 becomes `PASS`. ST-017 becomes `PASS` and ST-025/ST-026 are added, with evidence from `tools/ats207-probes/st-ats207.mjs`.
- ATS-506 adds UT-CP-001..030 (tests in `tests/control-plane.test.mjs`) to `UT` and IT-CP-SETUP, IT-CP-001..013, IT-CP-CLEANUP (tests in `tests/control-plane-it.test.mjs`) to `IT`, linked to FR-028, NFR-002, NFR-005, NFR-011 and FR-001.
- The RTM status of FR-028 stays `DESIGNED` (the rule `i <= 20` is unchanged): the control-plane boundary is a part of FR-028, not its implementation.
- Invariants: IDs are unique across UT/IT/ST; running the script twice produces identical files; the committed generated files equal the script's output.

## Change Notes

ATS-207 adds catalog rows and flips three statuses; the generator logic is unchanged. The new rows are appended with `UT += [...]` / `IT += [...]` / `ST += [...]` after the last block. The status flips (UT-DATA-001, ST-017) edit their rows in place. The lines that `docs/16-BASELINE-ADR.md` §3.1 and `tools/check_adr_citations.py` cite by position therefore do not move.
