# Test Design: `server/discovery/authoritative.mjs`

Source: `server/discovery/authoritative.mjs`

Source-SHA256: `d8b87a0806924624c1c82f10fe29cb1e0956552eb30e6971f14cbb4e37768270`

## Test Strategy

The tests use `node --test`.

- **Through the catalogue (unit).** `tests/mobile-import.test.mjs` drives the exported `authoritativeCatalog` of `server/core.mjs` with a synthetic listing (`carriedProject().discoverTrusted()`: the static scanner's reading of the real spec files in the shape `playwright test --list` is parsed into), so the trusted path runs without a Playwright install and with a small memory footprint. The registry cell is carried from one discovery to the next, as the Bridge carries it. Every discovery asserts that no two cases of the catalogue share a uid.
- **Through the Bridge (integration).** `tests/mobile-import-it.test.mjs` runs the same edit sequences against the real Bridge over HTTP, with a real `@playwright/test` install junctioned into the fixture project and the project marked as trusted, so every catalogue is `discovery=authoritative`. The test is skipped with the reason when the install fails; a skip is never written as a pass.
- **The resolver alone.** `tests/discovery.test.mjs`, `tests/discovery-regressions.test.mjs` and `tests/identity.test.mjs` call `resolveAuthoritativeIdentities` without a census and remain unchanged: the new parameters default to `null` and add nothing.
- **Red proof.** Each new test is run on the rejected tree `b93d2da` (exported with `git archive`) and fails there before it passes on the delivered tree.

## Test Cases

| ID | Input | Expected | Location |
|---|---|---|---|
| UT-MOB-317 | Trusted path, discovery 1: web `web case @TC-650` + scenario `Login`; discovery 2: the web case drops the token and the scenario declares `@TC-650` (T1, N2-cross-rev) | discovery 2 has no duplicate uid; the scenario holds `tc-650` (`explicit`); the web case does NOT get `tc-650` from the registry (`uidSource` is `derived`, `uidStable: true`) and carries `ambiguity.reason === 'explicit-uid-claimed-by-another-case'` with candidate `tc-650`; the warning reports the inconsistency; the merged cell holds `tc-650` once and it points at the Flow file; the reverse move (T2) still gives the web case the token | `tests/mobile-import.test.mjs` |
| UT-MOB-318 | Trusted path, one discovery: web `web login @TC-100` + scenario `mobile login @TC-100` (T3, E12) | neither case binds `tc-100`: both are `provisional`, `uidStable: false`, `ambiguity.reason === 'duplicate-explicit-uid'` with `explicitUid 'tc-100'`; the warning counts 2 cases; the static path over the same files gives the same verdict; a project in which only the web case declares the token binds it to the web case | `tests/mobile-import.test.mjs` |
| IT-ATS602-API-015 | Real Bridge + real Playwright, trusted project: (a) the T1 edit sequence over `GET /api/projects/:id/tests`; (b) a second trusted project with the T3 pair | every catalogue is `discovery=authoritative` with no duplicate uid; (a) the scenario holds `tc-650`, the web case does not and reports `explicit-uid-claimed-by-another-case`; (b) no case holds `tc-100`, both report `duplicate-explicit-uid` | `tests/mobile-import-it.test.mjs` |
| Probe r3-e2e | `node tools/ats602-probes/probe-round3-counterexamples-e2e.mjs <tree> <pw node_modules> <scratch> trusted\|untrusted` (the reviewer's probe, verbatim) | `RESULT: OK` in both modes | `docs/evidence/ATS-602/03d-round3-review-probes.log` |

## Boundary & Failure Cases

- Census absent (`null`) or not a `Set`: the resolver behaves as before; covered by the existing resolver tests.
- A reserved uid remembered by the position anchor (a dynamic case whose template is re-worded while another case declares its old token): the anchor hit is refused like a body hit; the case falls through to the title / scope ladder.
- The refused registry hit never overrides a stronger ambiguity (`duplicate-explicit-uid`, `render-shift-possible`, `identical-title`).

## Regression Scope

- `tests/discovery.test.mjs`, `tests/discovery-regressions.test.mjs`, `tests/identity.test.mjs`: the resolver without a census.
- `tests/mobile-import.test.mjs` UT-MOB-312..316 and `tests/mobile-import-it.test.mjs` IT-ATS602-API-012..014: the round-3 rules on both paths stay green.
- The reviewer's probes `r1`, `r1-e2e`, `r2`, `r2-reader`, `r2-e2e` (trusted and untrusted) stay `RESULT: OK`.
