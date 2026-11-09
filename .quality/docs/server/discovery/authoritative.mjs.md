# Technical Design: `server/discovery/authoritative.mjs`

Source: `server/discovery/authoritative.mjs`

Source-SHA256: `d8b87a0806924624c1c82f10fe29cb1e0956552eb30e6971f14cbb4e37768270`

## Responsibility

The authoritative discovery of a trusted project: the parsing of `playwright test --list` into a normalised case list, and the resolution of the stable UID of every listed case (`resolveAuthoritativeIdentities`). This design covers the identity resolution only; the list parsing (ATS-103 / ATS-204) is unchanged.

The resolver is the trusted-path counterpart of `resolveIdentities` in `server/uid.mjs`. The two resolvers apply the SAME identity rules to the web cases of a project; the authoritative one additionally knows the dynamic and parameterised cases and the position anchor (ATS-204).

## Dependencies

- `server/uid.mjs`: `normalizeTitleKey`, `bodyKeyOf`, `extractExplicitUid`, `deriveTestUid`, `provisionalTestUid`, `pruneRegistry`.
- `server/identity.mjs`: `reidentifyRendered` (the position anchor).
- Caller: `authoritativeCatalog` in `server/core.mjs`, which hands in the case list, the bodies, the registry cell, the scope and (ATS-602) the explicit token census of the whole catalogue.

## Public Contract

### `resolveAuthoritativeIdentities({ projectUid, cases, bodies, registry, scope, duplicateExplicitUids, claimedExplicitUids })`

- `cases`: the normalised case list of the CLI.
- `bodies`: `Map<"file line", {title, bodyText}>` from the static scanner.
- `registry`: the registry cell of the project (`{version, entries}`).
- `scope`: the set of spec files this discovery covered; only entries of these files are pruned.
- `duplicateExplicitUids` (optional `Set`): the `@TC-` tokens more than one case of the WHOLE catalogue declares, counted over both engines by the caller. A listed case that declares such a token does NOT bind it: it is provisional with `duplicateExplicit`, exactly as when two listed cases declare the same token. A missing or non-`Set` value adds nothing.
- `claimedExplicitUids` (optional `Set`): the tokens ANY case of the whole catalogue declares. Every one of them is RESERVED: no registry hit (by body fingerprint or by position anchor) may hand a reserved token to a case that does not declare it. A missing or non-`Set` value adds nothing.

Returns `{ items, registry }`: the resolved cases (`uid`, `uidSource`, `uidStable`, `basis`, optional `ambiguity`) and the pruned, merged registry cell.

### The identity ladder

For every listed case, in this order:

1. explicit `@TC-` token (`explicit`), unless the token is duplicated inside the list or inside the catalogue (`provisional`, `duplicate-explicit-uid`);
2. registry hit on the body fingerprint (`registry`, basis `body-key`), only for a source case with a unique body, and only when the remembered uid is NOT reserved;
3. position anchor (`registry`, basis `position-anchor`), only when the anchored uid is NOT reserved;
4. derived from the title key (`derived`, basis `title-key`), when the case is the single claimant of its title;
5. derived from the body key (`derived-body`), for a source case with a unique body;
6. derived from the describe path and title (`derived`, basis `scope-title`), then from file + describe path + title (`derived`, basis `authoritative-key`);
7. provisional, reported with its candidates.

A collision between two resolved cases is settled by the same rule as before: the explicit claim wins, every other claimant falls back to its body key or to a provisional uid.

### The reservation (ATS-602)

The reserved set is the union of the tokens the listed cases declare and `claimedExplicitUids`. A registry hit on a reserved uid is REFUSED and REPORTED: the case walks on down the ladder, and unless a stronger ambiguity is already attached it carries `ambiguity: { key, reason: 'explicit-uid-claimed-by-another-case', candidates: [{ uid }] }`. The report says that the memory of the past cases disagrees with the catalogue, which a reader has to know; the uid the case receives is usable.

Why the reservation lives here and not only in the caller: the registry remembers a token under the body of a case that has since dropped it. On the trusted path the web cases are resolved by THIS resolver, so without the reservation a web case that dropped `@TC-650` gets `tc-650` back from the registry in the same discovery in which a mobile scenario declares `@TC-650`, and two cases share one uid. The static path (`resolveIdentities`) has had this reservation since round 3; the trusted path has it from round 4, so the rule holds on both catalogue paths.

### Invariants

- No two listed cases receive the same uid.
- A token declared by any case of the catalogue is never issued by a registry hit to a case that does not declare it.
- A token declared by two cases of the catalogue (any engine) is bound by neither.
- Without a census, the resolver behaves exactly as before: the two new parameters default to `null`.

## Change Notes

ATS-602 round 4 (review finding T1 / T3 on the trusted path): `duplicateExplicitUids` and `claimedExplicitUids` added to `resolveAuthoritativeIdentities`; the body-fingerprint and the position-anchor registry hits refuse a reserved uid and report `explicit-uid-claimed-by-another-case`; a token duplicated across the catalogue is provisional on the web side as well. Everything else in the module is unchanged.
