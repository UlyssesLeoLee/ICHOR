# Technical Design: `server/core.mjs`

Source: `server/core.mjs`

Source-SHA256: `a82d1f748e1824e35e92f30f22b6d67f8b0b9fd27544f3445a97b9b433e26941`

## Responsibility

Pure functions and local processing of the Bridge. ATS-106 changes `safeRunArgs()` only (the v0.1-compatible vector helper next to `resolvePlaywright`): it passes the output directory under the parameter name `buildPlaywrightArgs` expects (`outputDir`), so the helper no longer throws a `TypeError` when the CLI declares `--output`, and its vector is subject to the ATS-106 assertions. The static discovery section (`walkTests` / `discoverStatic`, ATS-202) is not touched.

## Dependencies

- Upstream: `buildPlaywrightArgs` / `probePlaywrightCli` from `server/adapters/playwright-cli.mjs`.
- Downstream: callers of `safeRunArgs` (`tests/preflight.test.mjs`).

## Public Contract

- `safeRunArgs(project, testFile, output)` returns the vector of `buildPlaywrightArgs({ cli, options, outputDir: output, testFile })`; it throws `PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT` without a CLI and `INVALID_TEST_FILTER` / `INVALID_SOURCE_FILE` / `PATH_OUTSIDE_PROJECT` for a bad filter.

## Change Notes

ATS-106 fixes the `output`/`outputDir` parameter mismatch in `safeRunArgs`.
