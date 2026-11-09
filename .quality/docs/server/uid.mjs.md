# Technical Design: `server/uid.mjs`

Source: `server/uid.mjs`

Source-SHA256: `pending-until-implementation`

## Responsibility

The stable identifiers of the platform (ATS-201): project, run, attempt and test-case UIDs, the static case scanner, and `resolveIdentities`, the UID ladder of the web cases with its registry merge and pruning. This design covers the one contract ATS-602 round 3 touches: the **reserved tokens** of `resolveIdentities`.

## Dependencies

- Upstream: `node:crypto`.
- Downstream: `server/core.mjs` (`discoverStatic`), `server/discovery/authoritative.mjs` and `server/discovery/mobile-import.mjs` (`pruneRegistry`), `server/index.mjs`, the migration tools, `tests/identity.test.mjs`, `tests/discovery*.test.mjs`, `tests/mobile-import.test.mjs`.

## Public Contract

### `resolveIdentities({ projectUid, discovered, registry, scope, duplicateExplicitUids, extraCandidates, claimedExplicitUids })`

Unchanged ladder: explicit → registry → title key → body key → provisional, followed by collision resolution (explicit wins, then registry) and the ambiguity report.

**Reserved tokens.** `matchRegistry` never hands out a uid in the `reserved` set. The set is the union of:

- the explicit tokens the `discovered` cases themselves carry (as before);
- `claimedExplicitUids` (new, optional `Set`): the explicit tokens every case of the whole catalogue carries, both engines. The caller computes it over the web and the mobile titles.

A refused match is reported on the case as `registryConflict` / `ambiguity.reason = 'explicit-uid-claimed-by-another-case'`, exactly as a token reserved by a web case is today.

`claimedExplicitUids` of `null` or a non-Set means "nothing beyond the discovered cases", so every existing caller keeps its behaviour.

`duplicateExplicitUids` and `extraCandidates` are unchanged.

### `pruneRegistry(entries, candidates, scope)`

Unchanged. It is the pruning rule of every registry merge in the platform: an entry is dropped only when its file is inside `scope` and no candidate claims its uid; the newest entry per uid wins.

### Invariants

- A `@TC-` token declared by any case of the catalogue in this discovery is never handed to a different case by the registry.
- Callers that do not pass `claimedExplicitUids` see no change.

## Change Notes

ATS-602 round 3 (review finding N2-cross): `resolveIdentities` gains the optional `claimedExplicitUids`. Nothing else in the module changes.
