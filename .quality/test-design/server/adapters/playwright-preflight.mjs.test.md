# Test Design: `server/adapters/playwright-preflight.mjs`

Source: `server/adapters/playwright-preflight.mjs`

Source-SHA256: `10167d971e2dd11d5e45fa521140fdd006e4a3d3fc60456225fbfed1a7a6eeaf`

## Test Strategy

`node:test` unit tests in `tests/preflight.test.mjs` build fake project trees under `os.tmpdir()` (config, `node_modules/@playwright/test/{cli.js,package.json}`, `playwright`, `playwright-core/{package.json,browsers.json}`, a fake registry with `INSTALLATION_COMPLETE` markers) and call `preflightPlaywright` with explicit `env`/`platform`/`homedir`/`nodeVersion`, so the result does not depend on the host. The real-installation contract test `tests/preflight-real.test.mjs` runs against a real `@playwright/test` install when one is available and reports skipped (not passed) otherwise.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| UT-PF-001 | Complete fake install 1.64.1, every default browser installed | `ok=true`, no errors, no warnings, `version=1.64.1`, every check `ok` | `tests/preflight.test.mjs` |
| UT-PF-002 | No `playwright.config.*` in the root | error `PLAYWRIGHT_CONFIG_REQUIRED` with a hint | `tests/preflight.test.mjs` |
| UT-PF-003 | No CLI in any candidate location | error `PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT`; version/node/deps/browsers checks `skipped` | `tests/preflight.test.mjs` |
| UT-PF-004 | CLI package version `1.57.9`, `2.0.0`, `0.9.0` | error `PLAYWRIGHT_VERSION_UNSUPPORTED` with `detail.version` and `detail.supported` | `tests/preflight.test.mjs` |
| UT-PF-005 | Version `1.58.0` and `1.99.99` | no version error (inclusive lower bound, exclusive upper bound) | `tests/preflight.test.mjs` |
| UT-PF-006 | CLI package without `package.json`; version `banana`; `package.json` that is not JSON | warning `PLAYWRIGHT_VERSION_UNKNOWN`, `ok=true` | `tests/preflight.test.mjs` |
| UT-PF-007 | `engines.node` `>=24` with Bridge node `22.1.0`; `>=20` with `22.1.0` | first: error `PLAYWRIGHT_NODE_UNSUPPORTED`; second: no error | `tests/preflight.test.mjs` |
| UT-PF-008 | `@playwright/test` declares `playwright`, which is absent; `playwright` present but its `playwright-core` absent | error `PLAYWRIGHT_DEPENDENCY_MISSING` naming the missing package | `tests/preflight.test.mjs` |
| UT-PF-009 | Dependencies present but `playwright-core/browsers.json` missing | warning `PLAYWRIGHT_BROWSERS_UNVERIFIED` | `tests/preflight.test.mjs` |
| UT-PF-010 | Registry without any browser; a browser folder without `INSTALLATION_COMPLETE` | warning `PLAYWRIGHT_BROWSERS_NOT_INSTALLED` listing the missing browsers; `ok=true` | `tests/preflight.test.mjs` |
| UT-PF-011 | `browserRegistryDir` for win32 with/without `LOCALAPPDATA`, linux with/without `XDG_CACHE_HOME`, darwin, `PLAYWRIGHT_BROWSERS_PATH=0`, absolute and relative `PLAYWRIGHT_BROWSERS_PATH` | the directory of `docs/26-RUNNER-PREFLIGHT.md` §2.2 | `tests/preflight.test.mjs` |
| UT-PF-012 | darwin with a `revisionOverrides` entry for the host platform | the `<name>_<platform>_special-<rev>` folder is required | `tests/preflight.test.mjs` |
| UT-PF-013 | `parseVersion` / `compareVersions` on `1.64.1`, `v1.2.3`, `1.2.3-beta.1`, `1.2`, `x` | `[1,64,1]`, `[1,2,3]`, `[1,2,3]`, `null`, `null`; ordering correct | `tests/preflight.test.mjs` |
| UT-PF-014 | Several blocking problems at once (old version and a missing dependency) | both errors reported, in check order | `tests/preflight.test.mjs` |
| UT-PF-015 | `playwright` package whose `exports` does not expose `package.json` | the dependency counts as present (`ok=true`) | `tests/preflight.test.mjs` |
| CT-PF-001 | Real `@playwright/test` installation (`ATS_REAL_PLAYWRIGHT_PROJECT`, or `examples/sample-playwright` with `node_modules`) | `ok=true`, version read from the real package, default browsers found in the real registry; skipped with a reason when no real install exists | `tests/preflight-real.test.mjs` |

## Boundary & Failure Cases

Lower bound inclusive, upper bound exclusive; an unparseable version is a warning and never treated as compatible-and-verified; a dependency whose `package.json` is not exported (`ERR_PACKAGE_PATH_NOT_EXPORTED`) counts as present; a relative `PLAYWRIGHT_BROWSERS_PATH` is resolved against the project root.

## Regression Scope

The preflight runs on every Playwright run, so every existing run test (`tests/runner.test.mjs`, `tests/api.test.mjs`, `tests/execution-model-it.test.mjs`, the adapters/discovery/env suites) must keep passing with their test-double CLIs (no `package.json`, no `playwright-core`): those produce warnings only.

`tests/preflight-real.test.mjs` CT-ARG-001 additionally runs the real CLI through `createPlaywrightAdapter().start()` on an offline two-spec project that borrows the real `node_modules` through a junction: exit 0, only `ok.spec.ts` in the report. Negative controls: `tools/ats106-probes/mutation-tests.mjs` removes the upper version bound (M3) and the dependency resolution (M4) on a temporary copy; `tests/preflight.test.mjs` must fail for each.
