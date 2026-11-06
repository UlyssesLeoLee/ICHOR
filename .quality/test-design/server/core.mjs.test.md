# Test Design: `server/core.mjs`

Source: `server/core.mjs`

Source-SHA256: `a82d1f748e1824e35e92f30f22b6d67f8b0b9fd27544f3445a97b9b433e26941`

## Test Strategy

Unit tests in `tests/preflight.test.mjs` call `safeRunArgs` on a fake project whose CLI prints a `--help` that declares `--output`.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| UT-CORE-106-001 | Fake CLI declaring `--output`; `safeRunArgs(project, "tests/a.spec.ts", outDir)` | vector contains `--output <outDir>/results` and ends with `tests/a.spec.ts`; no `TypeError` | `tests/preflight.test.mjs` |
| UT-CORE-106-002 | `safeRunArgs(project, "-x.spec.ts", outDir)` with the file present | throws `INVALID_TEST_FILTER` | `tests/preflight.test.mjs` |

## Boundary & Failure Cases

Without a CLI the existing `PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT` is kept.

## Regression Scope

`tests/core.test.mjs` and the ATS-202 discovery suites.
