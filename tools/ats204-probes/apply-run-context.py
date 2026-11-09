"""ATS-204: the mapper needs to know about the WHOLE RUN, not one case.

Two of the signals cannot be judged from a single reported case:

  * the EXPLICIT token: two cases of the same run carrying `@TC-001` means
    NEITHER of them owns the token -- but the mapper is asked about one
    case at a time, so it has to be told how many cases of the run carry
    it;
  * the BODY fingerprint: a body that two cases of the same run share
    identifies neither of them -- and the same holds for the group of
    registry entries that share the file and the title.

So `bindReported()` takes the counts of the run:
  * `bodyCounts`   -- how many cases of the run share a fingerprint;
  * `explicitCounts` -- how many cases of the run carry a token.

`attemptsForRun()` computes both from the summary it is given.

    python tools/ats204-probes/apply-run-context.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = ROOT / 'server' / 'identity.mjs'
MODEL = ROOT / 'server' / 'execution' / 'model.mjs'

# ------------------------------------------------------------------ the mapper
OLD_SIG = """export function bindReported({
  entries = [], file = null, title = '', line = null, scope = null,
  bodyKey = null, bodyCounts = null, allowAlias = null,
} = {}) {"""
NEW_SIG = """export function bindReported({
  entries = [], file = null, title = '', line = null, scope = null,
  bodyKey = null, bodyCounts = null, explicitCounts = null, allowAlias = null,
} = {}) {"""

OLD_EXPLICIT = """  /* 1. the explicit annotation: the author wrote the uid down. */
  const explicit = extractExplicitUid(title);
  if (explicit) {
    const owners = usable.filter((e) => e.uid === explicit);
    if (owners.length === 1) return { uid: explicit, basis: 'explicit', candidates: 1 };
    return {
      uid: null,
      basis: 'explicit-ambiguous',
      candidates: owners.length,
      ambiguity: { reason: 'duplicate-explicit-uid', explicitUid: explicit },
    };
  }"""
NEW_EXPLICIT = """  /* 1. the explicit annotation: the author wrote the uid down. */
  const explicit = extractExplicitUid(title);
  if (explicit) {
    const owners = usable.filter((e) => e.uid === explicit);
    // The token belongs to the case that carries it -- and to ONE case.
    // Two cases of the SAME RUN carrying it means neither of them owns
    // it: only the author can say which case it belongs to.
    const claimants = explicitCounts ? (explicitCounts.get(explicit) ?? 0) : 0;
    if (owners.length === 1 && claimants <= 1) {
      return { uid: explicit, basis: 'explicit', candidates: 1 };
    }
    return {
      uid: null,
      basis: 'explicit-ambiguous',
      candidates: Math.max(owners.length, claimants),
      ambiguity: { reason: 'duplicate-explicit-uid', explicitUid: explicit },
    };
  }"""

OLD_BODY_GROUP = """    if (bodyKey) {
      const byBody = sameFileTitle.filter((e) => e.bodyKey === bodyKey);
      const uids = distinctUids(byBody);
      if (uids.length === 1) return { uid: uids[0], basis: 'file-title-body', candidates: 1 };
      if (uids.length > 1) {
        return {
          uid: null, basis: 'file-title-ambiguous', candidates: uids.length,
          ambiguity: { reason: AMBIGUITY.BODY, candidates: uids },
        };
      }"""
NEW_BODY_GROUP = """    if (bodyKey) {
      const byBody = sameFileTitle.filter((e) => e.bodyKey === bodyKey);
      const uids = distinctUids(byBody);
      const sharedInRun = bodyCounts ? (bodyCounts.get(bodyKey) ?? 0) : 1;
      // A body that TWO CASES OF THE SAME RUN share identifies neither of
      // them: the two cases are the same case as far as the fingerprint
      // can tell, and binding one of them to the other's uid is a
      // mis-association.
      if (uids.length === 1 && sharedInRun === 1) {
        return { uid: uids[0], basis: 'file-title-body', candidates: 1 };
      }
      if (uids.length > 1) {
        return {
          uid: null, basis: 'file-title-ambiguous', candidates: uids.length,
          ambiguity: { reason: AMBIGUITY.BODY, candidates: uids },
        };
      }
      if (sharedInRun > 1) {
        return {
          uid: null, basis: 'file-title-body-shared', candidates: sharedInRun,
          ambiguity: { reason: AMBIGUITY.BODY_SHARED, candidates: [] },
        };
      }"""

# ------------------------------------------------------------------ the model
OLD_COUNTS = """  const bodyCounts = new Map();
  for (const c of summary.cases) {
    const file = normalizeTestPath(c.file, { rootDir, projectRoot });
    const key = reportedBodyKey(projectRoot, file, c, bodyCache);
    if (!key) continue;
    bodyCounts.set(key, (bodyCounts.get(key) ?? 0) + 1);
  }
"""
NEW_COUNTS = """  const bodyCounts = new Map();
  for (const c of summary.cases) {
    const file = normalizeTestPath(c.file, { rootDir, projectRoot });
    const key = reportedBodyKey(projectRoot, file, c, bodyCache);
    if (!key) continue;
    bodyCounts.set(key, (bodyCounts.get(key) ?? 0) + 1);
  }
  /*
   * How many cases of THIS RUN carry an explicit token.
   *
   * The token belongs to the case that carries it -- and to ONE case. Two
   * cases of the same run carrying `@TC-001` means neither of them owns
   * it, and the mapper is asked about one case at a time, so it has to be
   * told.
   */
  const explicitCounts = new Map();
  for (const c of summary.cases) {
    const token = extractExplicitUid(c.title);
    if (!token) continue;
    explicitCounts.set(token, (explicitCounts.get(token) ?? 0) + 1);
  }
"""

OLD_CALL = """      bodyKey: reportedBodyKey(projectRoot, file, c, bodyCache),
      bodyCounts,
    });"""
NEW_CALL = """      bodyKey: reportedBodyKey(projectRoot, file, c, bodyCache),
      bodyCounts,
      explicitCounts,
    });"""

OLD_IMPORT = """import {
  attemptUidFor, bodyKeyOf, findTestUid, normalizeTestPath, scanTestCases,
} from '../uid.mjs';"""
NEW_IMPORT = """import {
  attemptUidFor, bodyKeyOf, extractExplicitUid, findTestUid, normalizeTestPath, scanTestCases,
} from '../uid.mjs';"""


def rewrite(path, edits):
    raw = path.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')
    for label, old, new in edits:
        if text.count(old) != 1:
            raise SystemExit('FAIL: %s -- the snippet is not there exactly once' % label)
        text = text.replace(old, new)
    path.write_bytes(text.replace('\n', nl).encode('utf-8'))
    print('rewrote %s' % path.relative_to(ROOT))


def main():
    rewrite(IDENTITY, [
        ('the signature', OLD_SIG, NEW_SIG),
        ('the explicit token', OLD_EXPLICIT, NEW_EXPLICIT),
        ('the body group', OLD_BODY_GROUP, NEW_BODY_GROUP),
    ])
    rewrite(MODEL, [
        ('the import', OLD_IMPORT, NEW_IMPORT),
        ('the counts', OLD_COUNTS, NEW_COUNTS),
        ('the call', OLD_CALL, NEW_CALL),
    ])
    return 0


if __name__ == '__main__':
    sys.exit(main())
