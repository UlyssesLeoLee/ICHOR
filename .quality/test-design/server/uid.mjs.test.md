# Test Design: `server/uid.mjs`

Source: `server/uid.mjs`

Source-SHA256: `pending-until-implementation`

## Test Strategy

`node --test`. The new parameter is exercised directly (`resolveIdentities` with a prepared registry) and through the catalogue (`discoverStatic` with web and mobile cases, the registry cell carried forward between rounds). The existing identity suites run unchanged and pin the default behaviour.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | UT-MOB-316: registry holds `{uid:'tc-900', bodyKey:B}`; `discovered` has one case with body `B` and no token; `claimedExplicitUids = Set(['tc-900'])` | the case is not `registry`; its uid differs from `tc-900`; `ambiguity.reason = 'explicit-uid-claimed-by-another-case'` with candidate `tc-900`; the same call without `claimedExplicitUids` yields `tc-900/registry` | `tests/mobile-import.test.mjs` |
| TC-002 | UT-MOB-313(a): through the catalogue, a web case drops `@TC-650` while a mobile scenario declares it | web case `derived`, mobile `tc-650/explicit`, no duplicate uid | `tests/mobile-import.test.mjs` |
| TC-003 | IT-ATS602-API-012: the same move over HTTP in the other direction (mobile drops, web declares) | no duplicate uid; web `tc-600/explicit` | `tests/mobile-import-it.test.mjs` |

## Boundary & Failure Cases

- `claimedExplicitUids` omitted, `null`, or an array: treated as empty.
- A token both reserved and declared by two web cases stays `duplicate-explicit-uid`.

## Regression Scope

- `tests/identity.test.mjs`, `tests/discovery.test.mjs`, `tests/discovery-regressions.test.mjs`, `tests/discovery-api.test.mjs`, `tests/migrate-regressions.test.mjs`.
- The full `npm test`.
