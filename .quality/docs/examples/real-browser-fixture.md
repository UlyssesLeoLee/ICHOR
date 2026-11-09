# Technical Design: `examples/real-browser-fixture/`

Source: `examples/real-browser-fixture/`

Source-SHA256: `037988968f75c2831c25db8668f0373db4522b2ecf56620a2f1c07f3c5debb0e`

This is the **tree digest** of the seven committed files of this directory, as computed by the repository's own `tools/tree_digest.mjs` over the export of the committed tree:

```
git archive HEAD examples/real-browser-fixture | tar -x -C <dir>
node tools/tree_digest.mjs <dir>/examples/real-browser-fixture
```

The recipe (normalises CRLF to LF for text files, keeps binary files byte-for-byte, sorts the per-file lines by relative path and hashes the joined result) is documented in `tools/tree_digest.mjs` itself, so the number above can be recomputed by a third party without trusting this document.

## Responsibility

The ATS-107 acceptance criterion is 「Chromium 上至少 1 PASS 1 FAIL；结果和错误信息与 CLI 一致」 -- "at least 1 PASS and 1 FAIL on Chromium; the results and the error messages are consistent with the CLI".

This directory is the **real browser test repository** that makes that criterion measurable:

- a self-contained Playwright project whose dependency tree is **pinned by a committed lockfile** (`package-lock.json`), so the browser version the acceptance was measured against is reproducible and not "whatever npm resolved today";
- **two offline specs** -- one that PASSES and one that FAILS on purpose -- so a single run of the fixture produces both verdicts the criterion names;
- no network access at all: each spec sets the page content itself, so the result depends on the engine and not on the network.

The fixture is a *source* repository. Its `node_modules` is produced by `npm ci` and is NOT under version control (see `.gitignore`: `examples/*/node_modules/`).

## Why a SEPARATE project and not `examples/sample-playwright`

`examples/sample-playwright` was written for ATS-301 as a *generic* adapter fixture: its `package.json` declares `^1.58.0` (a caret range) and it carries no committed lockfile. ATS-107 needs the opposite properties:

| Property | `examples/sample-playwright` | `examples/real-browser-fixture` |
| --- | --- | --- |
| dependency range | `^1.58.0` (caret) | exact pin |
| committed lockfile | none (`examples/*/package-lock.json` is gitignored) | **yes**, committed |
| verdicts in one run | 1 pass + 1 fail (already) | 1 pass + 1 fail (by contract) |
| purpose | generic adapter fixture | ATS-107 acceptance fixture |

The WBS row of ATS-107 requires exactly this: 「本项的真实浏览器夹具须在 apps/studio 或独立工程内以 lockfile 固定依赖」 -- "the real browser fixture of this item must pin its dependencies with a lockfile, inside apps/studio or a standalone project". A **standalone project** is the cheaper of the two: `apps/studio` is the Next.js UI, and adding a Playwright test tree to it would couple the UI's dependency lockfile to the browser engine.

## Dependencies

- Upstream: the npm registry (for `npm ci` only; the fixture itself needs no network at run time).
- Downstream:
  - `tools/ats107-probes/st-ats107.mjs` -- the regression probe that drives the fixture through the real Bridge and compares the result with a direct CLI run;
  - `tools/ats107-probes/collect-evidence.sh` -- the evidence collector;
  - `docs/31-REAL-BROWSER-FIXTURE.md` -- the human-readable design note.

## Public Contract

### `package.json`

```json
{"name":"ats107-real-browser-fixture","private":true,
 "scripts":{"test":"playwright test"},
 "devDependencies":{"@playwright/test":"1.65.0"}}
```

The version is **exact**, not a range: the acceptance criterion is measured against one engine version, and a caret range would let the fixture drift to a version nobody measured.

### `package-lock.json`

Committed. It pins `@playwright/test` and its transitive tree, so `npm ci` reproduces the exact engine the acceptance was measured against.

### `playwright.config.ts`

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { browserName: 'chromium' },
  timeout: 20000,
  retries: 0,
});
```

- `browserName: 'chromium'` -- the criterion names **Chromium** explicitly, so the project browser is pinned rather than left to the engine default.
- `retries: 0` -- a retry would turn the deliberate failure into a flaky case and change the counters the probe compares.

### `tests/passing.spec.ts` / `tests/failing.spec.ts`

Both specs are offline (`page.setContent(...)`) and both carry a `test.fail()`-free intent:

- the passing spec asserts that the element it set has the text it set;
- the failing spec asserts a text that the page does NOT have, so the assertion fails and the engine records the failure with its own error message.

The titles are stable and are referenced by the probe, so they must not change.

### `tests/expected.json`

The **expected verdicts**, as data:

```json
{"engine":"@playwright/test","browser":"chromium",
 "cases":[{"title":"…passing…","status":"passed"},
          {"title":"…failing…","status":"failed"}]}
```

The probe reads this file and compares it with BOTH the Bridge's summary and the direct CLI run. The file is the fixture's own contract: a change to the fixture's behaviour must be a change to this file too, so the probe fails loudly instead of accepting whatever the engine happens to produce.

## Invariants

- The fixture needs **no network**: both specs set the page content themselves.
- One run of the fixture produces **exactly one PASS and one FAIL** -- the criterion's "至少 1 PASS 1 FAIL".
- `npm ci` (not `npm install`) is the reproducible install; the lockfile is committed.
- The fixture's `node_modules` is never committed.

## Change Notes

New in ATS-107. The fixture is the artifact that turns the ATS-107 acceptance criterion from a prose claim into a runnable check.
