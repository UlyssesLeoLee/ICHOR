# Technical Design: `server/index.mjs`

Source: `server/index.mjs`

Source-SHA256: `3625e0b4ef2ba2834c50831d3517424f398865f18982d6822049ff50d3dbaf1a`

## Responsibility

The local Bridge HTTP server. ATS-106 touches two places only: the run route `POST /api/projects/:id/run` (request body field whitelist; the `file` filter goes through `assertSafeTestFilter` after `readSource`) and the run lifecycle `startRun()` (Playwright preflight between `run.queued` and `adapter.start()`).

## Dependencies

- Upstream (new): `preflightPlaywright` from `server/adapters/playwright-preflight.mjs`, `assertSafeTestFilter` from `server/adapters/playwright-cli.mjs`.
- Downstream: the run API consumers (`apps/studio`, `apps/studio/public/fallback.html`), `tests/preflight-it.test.mjs`.

## Public Contract

- `POST /api/projects/:id/run` accepts only `file`, `capabilities`, `runner`, `env`; any other key gives `400 { error: 'RUN_PARAMETER_NOT_ALLOWED', rejected: [...] }` before a run is created. An unsafe `file` gives `400 INVALID_TEST_FILTER`.
- `startRun()` for runner `playwright`: the preflight report is stored on `run.preflight`; when it is not ok the run gets a `run.error` event with `{ error, hint, preflight }`, `status='error'`, `error=<first blocking code>`, `errorHint`, `finishedAt`, and the engine is NOT spawned (no `pid`, no `command`). The HTTP answer stays `202 { run }`.
- Other runners are not preflighted.

## Change Notes

ATS-106 adds the whitelist, the filter check and the preflight gate; nothing else in the file changes.
