# Technical Design: `server/adapters/playwright-preflight.mjs`

Source: `server/adapters/playwright-preflight.mjs`

Source-SHA256: `9111f594988f83359bf53d13c185a2e8c2b497adced977df08aa36210073ed42`

## Responsibility

Environment preflight of a Playwright run, executed BEFORE the engine is spawned (design: `docs/26-RUNNER-PREFLIGHT.md` §2). From the file system only it answers whether the project's local Playwright installation can run: config present, local CLI present, CLI package version inside `SUPPORTED_PLAYWRIGHT_RANGE` (`>=1.58.0 <2.0.0`), CLI `engines.node` satisfied by the Bridge's Node, the Playwright-family dependencies declared by the CLI package resolvable down to `playwright-core`, and the default browsers installed in the registry directory the CHILD process will use. It never spawns a process, never touches the network and never installs anything (FR-009).

## Dependencies

- Upstream: Node `fs`, `path`, `os`, `module.createRequire`; `PLAYWRIGHT_CLI_CANDIDATES` from `server/adapters/playwright-cli.mjs`.
- Downstream: `server/index.mjs` `startRun()` (gate before `adapter.start()`); `tests/preflight.test.mjs`, `tests/preflight-it.test.mjs`, `tests/preflight-real.test.mjs`.

## Public Contract

- `SUPPORTED_PLAYWRIGHT_RANGE = { min: '1.58.0', maxExclusive: '2.0.0' }` (frozen).
- `PREFLIGHT_CODE`: frozen map of the blocking codes `PLAYWRIGHT_CONFIG_REQUIRED`, `PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT`, `PLAYWRIGHT_VERSION_UNSUPPORTED`, `PLAYWRIGHT_NODE_UNSUPPORTED`, `PLAYWRIGHT_DEPENDENCY_MISSING` and the warning codes `PLAYWRIGHT_VERSION_UNKNOWN`, `PLAYWRIGHT_BROWSERS_UNVERIFIED`, `PLAYWRIGHT_BROWSERS_NOT_INSTALLED`.
- `preflightPlaywright(projectRoot, { env, platform, homedir, nodeVersion } = {})` returns `{ ok, cli, version, registry, errors, warnings, checks }`; every error/warning is `{ code, hint, detail }`; `ok === (errors.length === 0)`; `checks` lists `{ name, status }` with status `ok` / `failed` / `warning` / `skipped`; the checks after a missing CLI are `skipped`.
- The `node` check reads `engines.node` only in the `>=N[.M[.P]]` form (a `v` prefix and whitespace are allowed) and compares that COMPLETE lower bound segment by segment against the Bridge's Node version, a missing segment counting as `0`; every other spelling of the field states no single lower bound, so the check is `skipped` rather than passed.
- `browserRegistryDir({ env, platform, homedir, coreDir, projectRoot })` returns the absolute registry directory (`docs/26-RUNNER-PREFLIGHT.md` §2.2).
- `parseVersion(text)` returns `[major, minor, patch]` or `null`; `compareVersions(a, b)` returns -1/0/1.
- Invariant: a pure function of the file system and its arguments; the defaults are `process.env`, `process.platform`, `os.homedir()`, `process.versions.node`.

## Change Notes

New module for ATS-106.
