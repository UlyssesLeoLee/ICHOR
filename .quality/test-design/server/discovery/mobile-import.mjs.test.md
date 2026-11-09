# Test Design: `server/discovery/mobile-import.mjs`

Source: `server/discovery/mobile-import.mjs`

Source-SHA256: `pending-until-implementation`

## Test Strategy

`node --test`. The unit tests in `tests/mobile-import.test.mjs` build a project in a `mkdtemp` directory, run `discoverStatic` (or the exported `authoritativeCatalog` with a synthetic listing) round after round, and carry the returned registry cell forward exactly as the Bridge does. The integration tests in `tests/mobile-import-it.test.mjs` drive a real Bridge over HTTP and edit the fixture files between two `GET /api/projects/<id>/tests` calls. Every new test asserts, after every discovery, that no two cases of the catalogue share a uid.

Red/green: every new case fails on the rejected tree `994e781` and passes on the delivered tree.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | UT-MOB-312 (N2-cross): discovery 1 has web `web case` and mobile `Login @TC-600`; discovery 2 drops the token from the scenario and adds `@TC-600` to the web case | no duplicate uid; web case `tc-600/explicit`; the scenario is `derived` and reports `explicit-uid-claimed-by-another-case` with candidate `tc-600`; the registry cell holds `tc-600` once, pointing at the web case | `tests/mobile-import.test.mjs` |
| TC-002 | UT-MOB-313 (N2 reverse and same engine): (a) web drops `@TC-650`, mobile declares it; (b) mobile `Login @TC-500` drops the token, mobile `Other` declares it | (a) no duplicate; mobile `tc-650/explicit`, web `derived`. (b) no duplicate; `Other` is `tc-500/explicit`, `Login` is `derived` with the registry conflict reported | `tests/mobile-import.test.mjs` |
| TC-003 | UT-MOB-314 (N3): scenario `Login` discovered; then `Login` gets an extra step and `Login copy` with the original steps is added; also the single-file path via `importFlowFile` with the registry of the first import | no duplicate uid; `Login copy` holds the old uid (`registry`); `Login` is `derived-body` with a new uid; the same outcome on the single-file import | `tests/mobile-import.test.mjs` |
| TC-004 | UT-MOB-315 (N1, trusted path): `authoritativeCatalog` with a synthetic listing over real spec files; discovery 2 deletes web `beta` and scenario `Logout`; discovery 3 adds web `gamma` with the body of beta and a new scenario with the steps of Logout; plus a retitle of the scenario on the same path | the uid of gamma differs from that of beta and is not `registry`; the uid of the new scenario differs from that of Logout and is not `registry`; the merged cell no longer holds the deleted uids after discovery 2; the retitled scenario keeps its uid and the cell holds exactly one entry for it with the NEW title | `tests/mobile-import.test.mjs` |
| TC-005 | UT-MOB-316: `mergeMobileRegistry` with an existing entry object and a case at a new position; `resolveIdentities` with `claimedExplicitUids` containing a uid the registry would hand to a case that does not declare it | the input entry object is unchanged, the returned entry carries the new position and an alias of the old one; an out-of-scope stale entry is kept, an in-scope stale entry is dropped; the web resolver refuses the registry hit and reports `explicit-uid-claimed-by-another-case` | `tests/mobile-import.test.mjs` |
| TC-006 | IT-ATS602-API-012 (N2-cross over HTTP, untrusted) | same as TC-001 through the API; no duplicate uid after each discovery | `tests/mobile-import-it.test.mjs` |
| TC-007 | IT-ATS602-API-013 (N3 over HTTP, untrusted) | same as TC-003 through the API | `tests/mobile-import-it.test.mjs` |
| TC-008 | IT-ATS602-API-014 (N1 over HTTP, trusted; skipped with the reason when no real Playwright is installed, and a skip is recorded as a skip) | `discovery=authoritative` on all three calls; same as TC-004 through the API | `tests/mobile-import-it.test.mjs` |
| TC-009 | Review probes `tools/ats602-probes/probe-round2-counterexamples.mjs`, `probe-round2-counterexamples-e2e.mjs` (`trusted` and `untrusted`), `probe-round2-reader.mjs` on the delivered tree | `RESULT: OK` for each; the round-1 probes still `RESULT: OK` | `docs/evidence/ATS-602/03c-round2-review-probes.log` |

## Boundary & Failure Cases

- A reserved token that is ALSO duplicated (two cases declare it) stays `duplicate-explicit-uid`; the reservation never upgrades it.
- The collision fallback never re-issues the contested uid: when the body-key fallback would equal the contested uid, the case becomes provisional.
- `claimedExplicitUids` of `null` or a non-Set is treated as empty (callers that resolve one file at a time).
- Pruning on the authoritative path uses the Flow files as the scope, so web entries outside it are kept whatever their uid.

## Regression Scope

- `tests/mobile-import.test.mjs` UT-MOB-200..311 (unchanged cases, in particular UT-MOB-242/281/283/284/285).
- `tests/mobile-import-it.test.mjs` IT-ATS602-API-001..011.
- `tests/identity.test.mjs`, `tests/discovery*.test.mjs` (the web resolver with the new optional parameter left at its default).
- The full `npm test`.
