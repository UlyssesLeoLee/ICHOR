# Test Design: `examples/real-browser-fixture/`

Source: `examples/real-browser-fixture/`

Source-SHA256: `PENDING`

## Test Strategy

The fixture is not a test suite of its own -- it is the **subject** of the ATS-107 regression. Its contract is exercised by `tools/ats107-probes/st-ats107.mjs`, which:

1. installs the fixture from its committed lockfile (`npm ci`);
2. runs it **twice** -- once directly through the Playwright CLI, once through the real Bridge (`POST /api/projects/{id}/run`);
3. compares the two runs' verdicts, counters and error messages against each other AND against the fixture's `tests/expected.json`.

The third step is what makes the criterion 「结果和错误信息与 CLI 一致」 measurable: the Bridge must not invent a verdict or rewrite the engine's error message.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | `npm ci` in the fixture | exits 0; `node_modules/@playwright/test/cli.js` exists | `tools/ats107-probes/st-ats107.mjs` (fixture setup) |
| TC-002 | the fixture's `package.json` | the `@playwright/test` version is an EXACT pin (no `^`/`~`) | `tools/ats107-probes/st-ats107.mjs` |
| TC-003 | the fixture's `package-lock.json` | it exists and is committed (`git ls-files`) | `tools/ats107-probes/st-ats107.mjs` |
| TC-004 | the fixture's `playwright.config.ts` | it names `chromium` and sets `retries: 0` | `tools/ats107-probes/st-ats107.mjs` |
| TC-005 | the direct CLI run | exit code 1 (one case fails); the JSON report has 1 expected + 1 unexpected | `tools/ats107-probes/st-ats107.mjs` |
| TC-006 | the Bridge run of the same fixture | `summary.passed === 1` and `summary.failed === 1` | `tools/ats107-probes/st-ats107.mjs` |
| TC-007 | the Bridge run vs. the direct CLI run | the per-case status of every case is IDENTICAL | `tools/ats107-probes/st-ats107.mjs` |
| TC-008 | the Bridge run vs. the direct CLI run | the failing case's error message is the engine's own (the assertion text is present); the Bridge neither drops nor rewrites it | `tools/ats107-probes/st-ats107.mjs` |
| TC-009 | the Bridge run vs. `tests/expected.json` | the verdicts match the fixture's declared expectations | `tools/ats107-probes/st-ats107.mjs` |
| TC-010 | the failing case's artifacts | a `trace.zip` exists under the run folder (the real engine wrote it) | `tools/ats107-probes/st-ats107.mjs` |
| TC-011 | the run's `report.json` | it exists in the run folder and is the JSON report the engine wrote | `tools/ats107-probes/st-ats107.mjs` |

## Boundary & Failure Cases

- **No real Chromium** on the machine: the probe reports SKIPPED with the reason -- a skip is NOT a pass, and the collector records it as such.
- **The engine version drifts** (a different `@playwright/test`): the probe reports the measured version, so a drift is visible in the evidence rather than hidden.
- **The Bridge's counters disagree with the CLI's**: the probe FAILS. This is the core of the acceptance criterion, so it is never tolerated.
- **The error message is empty**: the probe FAILS. "the failing case has no error message" is a different defect from "the error message differs from the CLI's", and both must be caught.
- **The fixture's expectations file is edited to match a broken run**: the probe compares against BOTH the CLI run and the file, so a fixture that drifts away from the CLI still fails.

## Regression Scope

`tests/adapters-it.test.mjs` (the adapter's own integration suite) and the ATS-301 option-selection suites must stay green. `tools/ats106-probes/mutation-tests.mjs` must still catch its nine guard mutations.
