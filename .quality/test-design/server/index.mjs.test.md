# Test Design: `server/index.mjs`

Source: `server/index.mjs`

Source-SHA256: `3625e0b4ef2ba2834c50831d3517424f398865f18982d6822049ff50d3dbaf1a`

## Test Strategy

Process-level IT in `tests/preflight-it.test.mjs`: a real Bridge (`node server/index.mjs`) on a free port with an isolated `ATS_DATA_DIR`, projects built from test-double CLIs whose `cli.js` writes a marker file when executed, so the test proves whether the engine was spawned.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| IT-PF-001 | Project whose CLI package is `1.40.0`; `POST run {}` | `202`; run ends `status=error`, `error=PLAYWRIGHT_VERSION_UNSUPPORTED`, `errorHint` set, `preflight.ok=false`; events `run.queued`, `run.error`; marker absent (engine never spawned) | `tests/preflight-it.test.mjs` |
| IT-PF-002 | Project whose `@playwright/test` declares `playwright`, which is absent | `error=PLAYWRIGHT_DEPENDENCY_MISSING`; marker absent | `tests/preflight-it.test.mjs` |
| IT-PF-003 | Project whose config file is deleted after registration | `error=PLAYWRIGHT_CONFIG_REQUIRED`; marker absent | `tests/preflight-it.test.mjs` |
| IT-PF-004 | Complete fake 1.64.1 install; `POST run {file:"tests/ok.spec.ts"}` | run `passed`; `preflight.ok=true`; marker present; `run.command` ends with the filter | `tests/preflight-it.test.mjs` |
| IT-PF-005 | `POST run {config:"evil.ts"}`, `{project:"x"}`, `{args:["--grep","x"]}` | `400 RUN_PARAMETER_NOT_ALLOWED` with `rejected`; no run created | `tests/preflight-it.test.mjs` |
| IT-PF-006 | `POST run {file:"-x.spec.ts"}` (exists at the root) and `{file:"tests/a+b.spec.ts"}` (exists) | `400 INVALID_TEST_FILTER`; no run created | `tests/preflight-it.test.mjs` |
| IT-PF-007 | `POST run {file:"../outside.spec.ts"}` | `400` with `PATH_OUTSIDE_PROJECT` (existing check, regression) | `tests/preflight-it.test.mjs` |
| IT-RUN-001 | Existing: project without dependencies | `202`, `status=error` (unchanged contract) | `tests/api.test.mjs` |

## Boundary & Failure Cases

A preflight failure never leaves the project locked: the run is terminal (`error`), so a second run request is accepted. The whitelist runs before the `capabilities` type check.

## Regression Scope

Whole `npm test` suite (run lifecycle, cancel, recovery, env profiles, adapter negotiation).

Negative controls (`tools/ats106-probes/mutation-tests.mjs`): M5 removes the whitelist, M6 the preflight gate, M7 the route filter check; `tests/preflight-it.test.mjs` must fail for each.
