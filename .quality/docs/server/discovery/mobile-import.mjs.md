# Technical Design: `server/discovery/mobile-import.mjs`

Source: `server/discovery/mobile-import.mjs`

Source-SHA256: `40f7b280cfb5293118a2114e54ddb941aecfd2d53943e3ac97aabe89081c5a2e`

## Responsibility

The semantic mapper of the mobile Flow import (ATS-602): the step vocabulary, argument normalisation, the preservation and marking of unsupported steps, the import report, and the **UID ladder of the mobile cases**. This design covers the UID ladder and the registry merge, which decide the identity of every mobile case of a project.

## Dependencies

- Upstream:
  - `server/uid.mjs`: `deriveTestUid`, `normalizeTitleKey`, `provisionalTestUid`, `pruneRegistry`.
  - `server/adapters/mobile-target.mjs`: `MOBILE_STEP_KINDS` (the closed vocabulary).
- Downstream:
  - `server/discovery/mobile-flow-import.mjs`: `importFlowFile` (one file), `importProjectFlows` (whole project).
  - `server/core.mjs`: `discoverStatic` and the authoritative catalogue resolve the mobile identities through `resolveProjectMobileUids` and merge the mobile entries into the registry cell of the project through `mergeMobileRegistry`.
  - `tests/mobile-import.test.mjs`, `tests/mobile-import-it.test.mjs`.

## Public Contract

### `resolveProjectMobileUids({ cases, projectUid, registry, scope, duplicateExplicitUids, claimedExplicitUids })`

Returns `{ cases, registry }`: every case with `uid`, `uidSource`, `uidStable`, `uidBasis`, `bodyKey`, `titleKey` and, when something had to be reported, `ambiguity`; and the registry **cell** of the project (`{version, entries}`) with the mobile entries merged in.

The ladder, per case:

| # | Condition | `uidSource` | `uidBasis` |
| --- | --- | --- | --- |
| 1 | the title carries `@TC-<token>` and no other case of the catalogue claims it | `explicit` | `explicit` |
| 2 | the registry remembers the step fingerprint (unique in the project) **and the remembered uid is not reserved** | `registry` | `body-key` |
| 3 | the title key is unique in the project | `derived` | `position-title` |
| 4 | the step fingerprint is unique in the project | `derived-body` | `body-key` |
| 5 | otherwise | `provisional` | — (`ambiguity` reported) |

**Reserved tokens.** A uid is reserved when any case of THIS discovery declares it explicitly. The reserved set is the union of:

- the tokens the mobile cases of this resolution declare (`explicitOwners`);
- `claimedExplicitUids`: the tokens every case of the whole catalogue declares, both engines (the caller computes it over the web and the mobile titles);
- the explicit entries of the registry whose file is outside `scope` (a token a case of another file already owns).

A registry hit whose uid is reserved is **refused**: the case falls through to rules 3–5 and carries `ambiguity = { reason: 'explicit-uid-claimed-by-another-case', candidates: [{uid}] }`. A reserved token is never handed to a case that does not declare it.

`duplicateExplicitUids` keeps its meaning: a token that more than one case of the catalogue declares belongs to none of them (`duplicate-explicit-uid`, provisional, `uidStable:false`).

**Collision resolution.** After the ladder, two cases may hold the same uid (a copied scenario hits the registry while the edited original re-derives the same uid from its position and title). One rule decides the holder, the same as `resolveIdentities` in `server/uid.mjs`: an `explicit` claim wins, then a `registry` claim, otherwise nobody. Every other claimant falls back to `derived-body` (position basis with the body key) when its step fingerprint is unique in the project, and to a provisional uid with `ambiguity.reason = 'identical-title'` otherwise. There is no third rule.

**Body scope.** `bodyScope: 'file'` (single-file import) restricts the registry match to the entries of that file, as before.

### `mergeMobileRegistry(entries, cases, scope)` (exported)

Merges the resolved mobile cases into a registry cell and returns a **new** cell `{version, entries}`:

- one entry per uid; an entry that already exists is **replaced by an updated copy** carrying the newest position (`file`, `title`, `line`, `titleKey`, `bodyKey`, `uidSource`); a moved case keeps its old position in `aliases`;
- the input `entries` are **not mutated**;
- the result is pruned with `pruneRegistry(merged, cases, scope)`: an entry whose file is inside `scope` and whose uid no case claims is dropped; entries outside the scope are kept.

The authoritative catalogue calls it with the entries of the cell the authoritative resolver has already pruned and with `scope = the Flow files`, so the two engines prune their own files and neither prunes the other.

### `bodyKeyOfCase(case)`

Unchanged: the SHA-256 of the step sequence (kind, arguments, assertion), or `null` without steps.

### Invariants

- No two cases of one resolution share a uid.
- A token declared by any case of the catalogue is given only to the case that declares it.
- A deleted case does not hand its uid to a later case with the same fingerprint when the file of the deleted case was part of the discovery.
- Resolving the same cases twice against the same registry object yields the same result (no hidden mutation).

## Change Notes

ATS-602 round 3 (review findings N2-cross and N3):

- **Added** `claimedExplicitUids` to `resolveProjectMobileUids`; registry hits on a reserved uid are refused and reported. Default `null` keeps the previous behaviour for callers that do not pass it.
- **Added** the collision step to the mobile ladder, mirroring the web resolver.
- **Exported** `mergeMobileRegistry`; it now copies entries instead of mutating the registry of the caller.
- **Unchanged:** the mapping, the report, the closed vocabulary, `bodyKeyOfCase`, the position basis of derived uids.
