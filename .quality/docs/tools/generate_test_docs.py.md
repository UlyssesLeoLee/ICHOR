# Technical Design: `tools/generate_test_docs.py`

Source: `tools/generate_test_docs.py`

Source-SHA256: `dd7a5e6b83538d7cf7db5fbcd768d0dd0eb083017cdcfb548d3e511bf8deb3b1`

## Responsibility

Single source of the UT/IT/ST test catalog. Running it regenerates `docs/07-UT-TEST-DESIGN.md`, `docs/08-IT-TEST-DESIGN.md`, `docs/09-ST-TEST-DESIGN.md`, `docs/10-RTM.md`, `tests/test-cases.json` and `tests/rtm.json` from the `UT`, `IT` and `ST` tuples, so the catalog, the traceability matrix and the machine-readable lists cannot drift apart.

## Dependencies

- Upstream: Python standard library `pathlib`, `json`, `re`; the catalog tuples in the file itself.
- Downstream: the six generated files above; `tools/ats101-probes/scenario-d-port-audit.mjs` (scans the file and its JSON output as non-runtime data); readers of `docs/10-RTM.md`.

## Public Contract

- Each catalog row is `(ID, requirement, category, title, input, expected, evidence, status)`; `status` is `PASS` only for an executed automated test, otherwise `PENDING`.
- ATS-506 adds UT-CP-001..030 (tests in `tests/control-plane.test.mjs`) to `UT` and IT-CP-SETUP, IT-CP-001..013, IT-CP-CLEANUP (tests in `tests/control-plane-it.test.mjs`) to `IT`, linked to FR-028, NFR-002, NFR-005, NFR-011 and FR-001.
- The RTM status of FR-028 stays `DESIGNED` (the rule `i <= 20` is unchanged): the control-plane boundary is a part of FR-028, not its implementation.
- Invariants: IDs are unique across UT/IT/ST; running the script twice produces identical files; the committed generated files equal the script's output.

## Change Notes

ATS-506 adds catalog rows only; the generator logic is unchanged.
