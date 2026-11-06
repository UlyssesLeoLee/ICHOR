# Technical Design: `server/adapters/playwright-cli.mjs`

Source: `server/adapters/playwright-cli.mjs`

Source-SHA256: `4167a216b046544f876b87c7a0fad111ce3a685618e5bf3a62256b493354d93a`

## Responsibility

The ONE place that builds the Playwright CLI argument vector (ATS-301). ATS-106 adds the argument safety baseline (`docs/26-RUNNER-PREFLIGHT.md` §3): the only user input that can enter the vector, the test file filter, is validated by `assertSafeTestFilter`, and the finished vector is checked as a whole by `assertSafePlaywrightArgv` before `buildPlaywrightArgs` returns it.

## Dependencies

- Upstream: `./contract.mjs` (`parseCliOptions`, `parseCliUsage`, `probeCommand`, `resolveProjectBinary`).
- Downstream: `server/adapters/playwright.mjs` `start()`, `server/core.mjs` `safeRunArgs()`, `server/index.mjs` run route (`assertSafeTestFilter`), `server/adapters/playwright-preflight.mjs` (`PLAYWRIGHT_CLI_CANDIDATES`).

## Public Contract

- `assertSafeTestFilter(file)` returns the filter with `/` separators; it throws `Error('INVALID_TEST_FILTER')` with `.code = 'INVALID_TEST_FILTER'` and `.reason` when the value is not a string, is empty or longer than 500 characters, contains a control character, starts with `-`, is absolute, contains `:`, contains a regex metacharacter `^ $ * + ? ( ) [ ] { } |`, or has a `..` segment.
- `assertSafePlaywrightArgv(args, { cli })` returns `args`; it throws `Error('UNSAFE_CLI_ARGUMENT')` with `.code` and `.reason` unless the vector is exactly `<cli> test [--reporter=line,json,html] [--output <absolute>] [--trace on] [--workers 1] [<safe filter>]` with each option at most once and no control character anywhere.
- `buildPlaywrightArgs({ cli, options, outputDir, testFile })`: unchanged option selection; `testFile` passes through `assertSafeTestFilter`; the result passes through `assertSafePlaywrightArgv`.

## Change Notes

ATS-106 adds the two assertions and wires them into `buildPlaywrightArgs`. The positional filter keeps its relative-path format.
