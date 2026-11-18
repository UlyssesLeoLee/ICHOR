# Technical Design: `server/import/design-index.mjs`

Source: `server/import/design-index.mjs`

Source-SHA256: `f1551bf9ea50ec4796f95846e1040acc26dff975b7291cfa4aae4693d59198fb`

## Responsibility

The DESIGN MATERIAL INDEXER (ATS-308): it reads the Markdown design documents
of a tree, classifies every reference they make, and reports what does not
resolve. It is strictly READ-ONLY — the acceptance criterion of the task is
「导入 md/json 关系不改正文」, so nothing is ever written.

This design covers the CLASSIFIER, because the classifier is what decides
whether the report can be trusted: a report that cries wolf (a runtime
artefact reported as a broken link) is a report nobody reads, and a report
that invents a fact (a broken link reported as resolved) is worse than no
report at all.

## Dependencies

- Upstream: none. The module reads the filesystem and nothing else — it does
  not import the Bridge, the state, or the traceability graph.
- Downstream:
  - `server/index.mjs`: `GET /api/design/import` and
    `GET /api/projects/:id/import`.
  - `tests/ats308-import.test.mjs` (UT), `tests/ats308-import-it.test.mjs` (IT),
    `tests/ats308-import-mutation.test.mjs` (the negative control).
  - `tools/ats308-probes/probe-design-import.mjs`.

## Public Contract

### `classifyReference(token, tree) -> {kind, token, candidates}`

The heart of the module, and a **pure function** of (token, tree) so that it
can be tested on its own and so that the report can be recomputed from a
different tree without changing a line of the importer.

The resolution order — the **first** rule that matches decides:

| # | Condition | `kind` |
|---|---|---|
| 1 | the path exists as written | `resolved` |
| 2 | the path's SUFFIX matches exactly ONE tracked file | `resolved` |
| 3 | a bare basename that matches exactly ONE tracked file | `resolved` |
| 4 | a bare basename that matches SEVERAL tracked files | `ambiguous` |
| 5 | a bare basename that matches NO file, but IS a runtime artefact's name | `runtime` |
| 6 | the FIRST segment is a build-output directory (`out/`, `node_modules/`, …) | `runtime` |
| 7 | the DIRECTORY is not in this tree | `external` |
| 8 | anything else | `broken` |

Three rules of the classifier carry the design:

- **The suffix rule stops at ONE match.** Two candidates mean the reference
  is ambiguous; the report says so instead of picking one.
- **`external` is not `broken`.** The design documents describe the platform
  AND the projects it drives, and they name paths like `flows/android.yaml`
  that belong to a project under test. Reporting those as broken would put a
  dozen false defects into every report. The rule is mechanical: if the
  document names a directory this repository does not have, the reference is
  about something else. A reference whose directory DOES exist but whose file
  does NOT is a genuine broken link.
- **`runtime` is a CLOSED set.** `RUNTIME_ARTEFACTS` names the files the
  platform creates while it runs (`state.json`, `report.json`,
  `manifest.json`, …). A name that is not in the set is resolved against the
  tree like any other file, so an UNRECOGNISED runtime artefact shows up as
  broken rather than being silently excused.

### `importDesignMaterials({root, only}) -> {version, root, materials, references, report}`

The import. It reads, classifies and returns; it never writes. The result is
a pure function of the tree: the same tree always produces the same index,
and the index can be diffed across commits.

- `materials` — one entry per design document and per tracking asset, with
  its `uid`, `sha256`, byte count, its headings and its reference count.
- `references` — one entry per reference, with its `uid`, the document it
  came from, the line, the token, the `kind` and the candidates.
- `report` — the counts (`byKind`), the broken references GROUPED BY TOKEN
  (a broken link mentioned twelve times is ONE defect, not twelve), and the
  ambiguous references with their candidates.

### The uid rules

| Entity | uid | Basis |
|---|---|---|
| material | `dmi_1_<24 hex>` | `sha256("material" ␀ path)` |
| reference | `dmr_1_<24 hex>` | `sha256("reference" ␀ path ␀ line ␀ token)` |

The basis is never a position in an array and never a counter. The same
document has the same uid in every checkout, so the index can be diffed
across commits. The reference uid carries the LINE, because the same token
on two lines of one document is two facts.

## Error Handling

- A file that cannot be read is **not an exception**: the material entry
  carries `error`, and the import continues.
- A malformed asset is **not an exception**: the tracking asset importer
  reports it as an issue.
- The classifier never throws: an unresolvable token is a `broken`
  reference, not a crash.

## Known Boundaries

- The `broken` vocabulary does NOT distinguish a genuinely missing file from
  another kind of absence (an issue attachment, a name from another tree, a
  runtime artefact). The report is therefore **stronger** than the truth.
  `docs/35-DESIGN-IMPORT.md` §11 records this with the measured counts.
- The section-reference (`§N`) verification is **not implemented**: the index
  reads the heading numbers but does not check the `§` references against
  them.
- The index covers the tree it is given; the import of a project's OWN
  design baseline (as opposed to the platform's) is not implemented.
