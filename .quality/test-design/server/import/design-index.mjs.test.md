# Test Design: `server/import/design-index.mjs`

Source: `server/import/design-index.mjs`

Source-SHA256: `f1551bf9ea50ec4796f95846e1040acc26dff975b7291cfa4aae4693d59198fb`

## Test Strategy

`node --test tests/ats308-import.test.mjs` (UT),
`node --test tests/ats308-import-it.test.mjs` (IT) and
`node --test tests/ats308-import-mutation.test.mjs` (the negative control).

**The fixtures are BUILT, not read from the real tree.** A test that reads
the real repository measures the repository, not the code: it would fail
whenever a document is added, and it could not exercise the interesting
shapes (a document that names a file that is not there, a name that two
files share, a runtime artefact).

**ONE test does read the real tree** (UT-ATS308-060), and it is marked as
such: "every reference the real baseline makes to a file of this repository
resolves" is a property of the DATA, not of the fixture.

**The negative control is a separate file on purpose.** The mutation tests
copy the importer into a temp directory, mutate the copy, and assert that
the mutated behaviour is the wrong one. The repository's own source is never
touched. A test nobody can fail guards nothing, so the mutations are the
evidence that the tests have discriminating power.

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
|---|---|---|---|
| TC-001 | a built fixture tree; the digest of every file before and after both importers | the digest is identical and the file count is identical | `tests/ats308-import.test.mjs` |
| TC-002 | the same fixture imported twice | the two reports are deeply equal; the material digests are equal | `tests/ats308-import.test.mjs` |
| TC-003 | `materialUid` / `referenceUid` | the same path gives the same uid; two paths differ; the same token on two lines differs | `tests/ats308-import.test.mjs` |
| TC-010 | a path that exists as written | `resolved`, the candidate is that file | `tests/ats308-import.test.mjs` |
| TC-011 | a bare basename that matches one file | `resolved` | `tests/ats308-import.test.mjs` |
| TC-012 | a bare basename that matches two files | `ambiguous`, both candidates listed, **no** candidate chosen | `tests/ats308-import.test.mjs` |
| TC-013 | a path whose directory exists but whose file does not | `broken` | `tests/ats308-import.test.mjs` |
| TC-014 | a path whose directory this tree does not have | `external`, **not** `broken` | `tests/ats308-import.test.mjs` |
| TC-015 | every name in `RUNTIME_ARTEFACTS`, plus `out/index.html` | all `runtime` | `tests/ats308-import.test.mjs` |
| TC-016 | two files with the same suffix | `ambiguous` — the suffix rule never guesses | `tests/ats308-import.test.mjs` |
| TC-017 | three names that exist nowhere | none is `resolved` | `tests/ats308-import.test.mjs` |
| TC-020 | prose, an extension list, a bare word | only the path-shaped tokens are extracted | `tests/ats308-import.test.mjs` |
| TC-021 | references on two known lines | the line numbers are right | `tests/ats308-import.test.mjs` |
| TC-022 | a document with headings `1`, `2`, `2.1` | the numbers and titles are read | `tests/ats308-import.test.mjs` |
| TC-030 | a fixture with two broken references | the report names both tokens and the places that name them; the resolved ones are not listed | `tests/ats308-import.test.mjs` |
| TC-031 | the fixture's report | the counts sum to the reference count | `tests/ats308-import.test.mjs` |
| TC-032 | the readable report | it carries the counts and the findings | `tests/ats308-import.test.mjs` |
| TC-033 | the material list of a fixture | the design documents are in it; the source and `package.json` are not | `tests/ats308-import.test.mjs` |
| TC-040…TC-050 | the tracking asset cases (a clean import, a dangling requirement, an unknown case, a missing file, a duplicate link, a duplicate requirement, a malformed asset, a malformed target, the `file::title` split, the uid rules, the case titles) | each is reported with its own issue kind | `tests/ats308-import.test.mjs` |
| TC-060 | the REAL repository | every `resolved` reference names a file that exists; the counts sum | `tests/ats308-import.test.mjs` |
| TC-061 | the REAL repository, twice | the reports are equal | `tests/ats308-import.test.mjs` |
| IT-001 | the real Bridge + a fixture project | the endpoint answers with the assets AND the design material | `tests/ats308-import-it.test.mjs` |
| IT-002 | a fixture whose assets carry drift | the endpoint reports the unknown case, the dangling requirement and the broken reference | `tests/ats308-import-it.test.mjs` |
| IT-003 | the fixture's digest before and after the call | the digest is identical | `tests/ats308-import-it.test.mjs` |
| IT-004 | a POST to the import endpoint | 404 — the import is not writable | `tests/ats308-import-it.test.mjs` |
| IT-005 | the import endpoint without the session token | 401 | `tests/ats308-import-it.test.mjs` |
| IT-006 | the top-level endpoint, with and without `?detailed=true` | the baseline is imported; every resolved candidate exists | `tests/ats308-import-it.test.mjs` |
| IT-007 | a design document before and after the top-level import | byte-identical | `tests/ats308-import-it.test.mjs` |
| M1 | the importer mutated so the broken links are not collected | the broken list is empty — the mutation is caught | `tests/ats308-import-mutation.test.mjs` |
| M2 | the importer mutated so the ambiguous links are not collected | the ambiguous list is empty — the mutation is caught | `tests/ats308-import-mutation.test.mjs` |
| M3 | the importer mutated so a broken link is reported as resolved | the report names a candidate that does not exist — the mutation is caught | `tests/ats308-import-mutation.test.mjs` |
| M4 | the importer mutated so a runtime artefact is reported broken | the report cries wolf — the mutation is caught | `tests/ats308-import-mutation.test.mjs` |
| M5 | the importer mutated so an external path is reported broken | the report cries wolf — the mutation is caught | `tests/ats308-import-mutation.test.mjs` |
| M6 | the importer mutated so the import appends a line to the body | the body changes — the acceptance criterion is violated, the mutation is caught | `tests/ats308-import-mutation.test.mjs` |
| M7 | the importer mutated so the classifier picks one of several candidates | the report invents a fact — the mutation is caught | `tests/ats308-import-mutation.test.mjs` |

## Boundary & Failure Cases

- Each mutation test asserts BOTH directions: the mutated behaviour is the
  wrong one, **and** the unmutated importer does the right thing. A mutation
  test that only checked the first half would pass on an importer that was
  already broken.
- The mutation anchors are matched against the source text, so a mutation
  whose anchor no longer exists FAILS loudly instead of silently testing
  nothing.
- The classifier must never resolve a reference it cannot back with a file:
  TC-060 asserts that property against the real tree, one candidate at a
  time.
- The import must not change a byte: TC-001 and IT-003 hash the whole tree.
  M6 proves the assertion has discriminating power.

## Regression Scope

`npm test` must pass (the full suite, ~2000 cases).
`bash tools/ats301-probes/check-ats301-gate.sh` must pass — the delivery
adds code to `server/index.mjs`, and the gate checks the ADR's line
citations against the source, so the citations have to follow the shift.
`bash tools/ats501-probes/check-wbs-updaters.sh` must pass with
`tools/update_wbs_ats308.py` discovered — it checks the coexistence, the
order independence and the idempotence of all the updaters against the
SHARED workbook.
