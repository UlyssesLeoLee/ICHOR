# Test Design: `tools/ats107-probes/st-ats107.mjs`

Source: `tools/ats107-probes/st-ats107.mjs`

Source-SHA256: `fc09c33c411485ac58ac047f25de0205f4a6c56111d0db72558cde49b451bff5`

## Test Strategy

The probe is itself checked by **negative controls**: the probe must FAIL when the thing it claims to check is broken. Without them, a probe that always prints PASS would look like a delivery.

The controls are layered, because they prove different things:

| Layer | What it mutates | What it proves |
| --- | --- | --- |
| 1 -- `mutation-check.mjs` | an in-memory COPY of the Bridge's result projection | the COMPARISON LOGIC has teeth |
| 2 -- `no-browser-control.mjs` | the FIXTURE (its specs never take a `page`, so no browser is launched) | the "real browser" check rejects a run that never started a browser |
| 2 -- `product-mutation-control.sh` | a COPY of the PRODUCT SOURCE (it truncates the error message it reports) | the probe rejects a broken product on the REAL chain |

Layer 1 alone is not enough: a comparison can be strict while the probe never sees the broken output. Layer 2 closes that gap from both sides.

The layer-1 mutations are the ways the acceptance criterion could be silently broken:

| Mutation | What it simulates | Which check must catch it |
| --- | --- | --- |
| M1 | the Bridge counts the failing case as passed | the counter comparison (ST-4 / ST-8) |
| M2 | the Bridge reports 2 passed / 0 failed | the counter comparison (ST-3) |
| M3 | the Bridge swaps the two cases' verdicts | the per-case comparison (ST-4) |
| M4 | the Bridge drops the error message | the error-message check (ST-5) |
| M5 | the Bridge rewrites the error message into its own wording | the error-message check (ST-5) |
| M6 | the Bridge reports the right counts but the wrong per-case verdicts | the per-case comparison (ST-4) |
| M7 | the Bridge's verdicts differ from the fixture's declared expectations | the expectation comparison (ST-6) |
| M8 | the Bridge loses a case entirely | the per-case comparison (ST-4) |
| M9 | the Bridge reports a case the CLI did not run | the per-case comparison (ST-4) |
| M10 | the Bridge reports a wrong total | the counter comparison (ST-8) |
| M11 | the Bridge TRUNCATES the error message (keeps the first line and the assertion text) | the error-message EQUALITY check (ST-5) |
| M12 | the Bridge truncates the error message behind ANSI escape sequences | the error-message EQUALITY check (ST-5) |
| M13 | the Bridge attaches a DIFFERENT case's error message | the error-message comparison, which pairs by TITLE (ST-5) |

M11 is the mutation that forces the error comparison to be an EQUALITY check: a containment check accepts a truncated message, because the kept parts are contained in the CLI's text.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | M1 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-002 | M2 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-003 | M3 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-004 | M4 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-005 | M5 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-006 | M6 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-007 | M7 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-008 | M8 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-009 | M9 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-010 | M10 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-011 | M11 (truncated error message) | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-012 | M12 (truncation behind ANSI) | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-013 | M13 (another case's error message) | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-014 | the unmutated projection | NOT caught (the comparison logic accepts the honest result) | `tools/ats107-probes/mutation-check.mjs` |
| TC-015 | the REAL fixture (its specs take a `page`) | ACCEPTED as a real-browser run: the trace archive holds a `<n>-trace.trace` whose `context-options` event says `browserName: chromium` | `tools/ats107-probes/no-browser-control.mjs` |
| TC-016 | the MUTATED fixture (its specs never take a `page`, so no browser is launched) | REJECTED: the archive holds no browser context -- even though a `trace.zip` IS written | `tools/ats107-probes/no-browser-control.mjs` |
| TC-017 | the product COPY whose `server/execution/model.mjs` truncates the reported error message | the probe FAILS at ST-5 (cli=401 chars vs bridge=111 chars) and exits non-zero | `tools/ats107-probes/product-mutation-control.sh` |
| TC-018 | the unmutated product | the probe PASSES (exit code 0) | `tools/ats107-probes/product-mutation-control.sh` |

## Boundary & Failure Cases

- The controls must not touch the product source or the committed fixture: layer 1 mutates an in-memory copy, layer 2 mutates a COPY of the tree.
- A mutant that the comparison logic accepts is a failure of the CONTROL, not of the product -- the control fails loudly.
- A trace archive existing is NOT evidence of a browser: TC-016 asserts that the mutated fixture still writes one, so the rejection cannot be mistaken for "no trace at all".
- The product control must fail for the RIGHT reason: it greps the probe's output for the ST-5 failure, so a probe that failed for an unrelated reason does not count as a pass.
- The probe exits non-zero when the browser is missing (fail-closed), not zero with a SKIP.

## Regression Scope

`tests/adapters-it.test.mjs` and the ATS-301 suites stay green. The ATS-106 guard mutations (`tools/ats106-probes/mutation-tests.mjs`) must still be caught -- ATS-107 depends on the preflight baseline ATS-106 delivered. `tests/ats107-real-browser-it.test.mjs` asserts the same criterion from the API's side.
