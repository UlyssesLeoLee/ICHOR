# Test Design: `tools/ats107-probes/st-ats107.mjs`

Source: `tools/ats107-probes/st-ats107.mjs`

Source-SHA256: `PENDING`

## Test Strategy

The probe is itself checked by a **negative control**: the probe must FAIL when the thing it claims to check is broken. Without it, a probe that always prints PASS would look like a delivery.

The negative control lives in `tools/ats107-probes/mutation-check.mjs`:

1. it copies the repository's fixture to a scratch directory;
2. it applies one mutation at a time to a COPY of the Bridge's own result projection (the summary the Bridge would report) -- NOT to the product source, so the control never touches the tree under test;
3. it runs the probe's comparison logic against the mutated projection;
4. every mutation must be caught.

The mutations are the ways the acceptance criterion could be silently broken:

| Mutation | What it simulates | Which check must catch it |
| --- | --- | --- |
| M1 | the Bridge counts the failing case as passed | the counter comparison (ST-4 / ST-8) |
| M2 | the Bridge reports 2 passed / 0 failed | the counter comparison (ST-3) |
| M3 | the Bridge swaps the two cases' verdicts | the per-case comparison (ST-4) |
| M4 | the Bridge drops the error message | the error-message check (ST-5) |
| M5 | the Bridge rewrites the error message into its own wording | the error-message check (ST-5) |
| M6 | the Bridge reports the right counts but the wrong per-case verdicts | the per-case comparison (ST-4) |
| M7 | the Bridge's verdicts differ from the fixture's declared expectations | the expectation comparison (ST-6) |

A mutation that is NOT caught fails the control -- so the probe cannot be vacuous.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | the probe with a fixture whose lockfile pins a caret range | ST-1 fails (the pin is not exact) | `tools/ats107-probes/mutation-check.mjs` (fixture mutants) |
| TC-002 | the probe with a fixture that has no committed lockfile | ST-1 fails | `tools/ats107-probes/mutation-check.mjs` (fixture mutants) |
| TC-003 | the probe with a fixture whose config does not name chromium | ST-1 fails | `tools/ats107-probes/mutation-check.mjs` (fixture mutants) |
| TC-004 | the probe with a fixture whose config sets `retries: 1` | ST-1 fails | `tools/ats107-probes/mutation-check.mjs` (fixture mutants) |
| TC-005 | M1 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-006 | M2 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-007 | M3 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-008 | M4 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-009 | M5 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-010 | M6 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-011 | M7 | caught | `tools/ats107-probes/mutation-check.mjs` |
| TC-012 | the unmutated projection | NOT caught (the comparison logic accepts the honest result) | `tools/ats107-probes/mutation-check.mjs` |

## Boundary & Failure Cases

- The control must not touch the product source: it copies the tree it mutates.
- A mutant that the comparison logic accepts is a failure of the CONTROL, not of the product -- the control fails loudly.
- The fixture mutants are applied to a COPY, so the committed fixture is never left mutated.
- The control needs no browser of its own: it reuses the engine report the real run produced, so it does not pay for a second browser launch.

## Regression Scope

`tests/adapters-it.test.mjs` and the ATS-301 suites stay green. The ATS-106 guard mutations (`tools/ats106-probes/mutation-tests.mjs`) must still be caught -- ATS-107 depends on the preflight baseline ATS-106 delivered.
