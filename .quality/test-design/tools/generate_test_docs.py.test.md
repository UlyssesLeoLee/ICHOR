# Test Design: `tools/generate_test_docs.py`

Source: `tools/generate_test_docs.py`

Source-SHA256: `497f058c2e493ae585766b7c30ae8f3792f1e7bbfbe2c4611eff96f2b09a51a7`

## Test Strategy

pytest in `tools/test_generate_test_docs.py`. The script is executed in-process with `runpy.run_path` while `pathlib.Path.write_text` is replaced by a recorder, so nothing is written to the repository and coverage is attributed to the real file. The recorded outputs are compared with the committed files and with the test sources.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | Run the generator with the recorder | exactly six outputs: docs/07, docs/08, docs/09, docs/10, tests/test-cases.json, tests/rtm.json | `tools/test_generate_test_docs.py` |
| TC-002 | Compare each recorded output with the committed file | byte-identical (the committed catalog is fresh) | `tools/test_generate_test_docs.py` |
| TC-003 | IDs of all rows in `tests/test-cases.json` output | unique; every `UT-CP-*` row has level UT and every `IT-CP-*` row level IT | `tools/test_generate_test_docs.py` |
| TC-004 | Every `UT-CP-NNN` / `IT-CP-*` ID in the catalog vs the test titles in `tests/control-plane.test.mjs` / `tests/control-plane-it.test.mjs` | each catalog ID appears as a test title prefix and vice versa | `tools/test_generate_test_docs.py` |
| TC-005 | FR-028 row of the recorded `tests/rtm.json` | lists the UT-CP/IT-CP cases; status `DESIGNED` | `tools/test_generate_test_docs.py` |
| TC-006 | Run the generator twice with the recorder | identical outputs | `tools/test_generate_test_docs.py` |

## Boundary & Failure Cases

A catalog row whose status is `PASS` must have an automated evidence (`node --test`); the port audit treats this file as non-runtime data, so the catalog must not introduce new port mentions; a missing test title for a catalog ID fails TC-004.

## Regression Scope

`docs/07`..`docs/10`, `tests/test-cases.json`, `tests/rtm.json`. The ATS-101 port audit and the ATS-501 protocol audit (which reads `docs/02`, not the RTM) must keep their results.
