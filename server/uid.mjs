/**
 * ATS-201: stable UID scheme (v1) for Project / TestDefinition / Run / Attempt.
 *
 * The scheme is pure: no filesystem, no clock, no randomness. Every UID is a
 * deterministic function of documented inputs, so the same inputs always
 * produce the same UID on any machine and after any restart. That is what
 * makes the scheme migratable: `tools/migrate_uids.mjs` can recompute the UIDs
 * of records that were written under an older scheme.
 *
 * UID string format: <kind>_<version>_<payload>
 *
 *   Project         proj_1_<24 hex>     sha256(canonical project root)[0:24]
 *   TestDefinition  tc-<token>          explicit, user assigned (@TC-<token>)
 *                    tc_1_d_<16 hex>     derived (title basis or body basis)
 *                    tcp_1_<16 hex>_<n> provisional: not stable, flagged
 *   Run             run_1_<24 hex>      sha256(project, commit, target, seq)
 *   Attempt         att_1_<24 hex>      sha256(run, test, retry, occurrence)
 *
 * Legacy identifiers written before this scheme (`proj_<uuid>` / `run_<uuid>`)
 * stay readable so that existing state files keep working until the migration
 * script rewrites them.
 *
 * The identity rules are documented in `docs/18-UID-SPEC.md`.
 */
import crypto from 'node:crypto';
import path from 'node:path';

export const UID_SCHEME_VERSION = 1;
export const LEGACY_SCHEME_VERSION = 0;

/** Separator that cannot occur in a path, a title or a hash. */
const NUL = '\x00';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const PROJECT_UID_RE = /^proj_(?:[0-9a-f-]{36}|1_[0-9a-f]{24})$/;
export const RUN_UID_RE = /^run_(?:[0-9a-f-]{36}|1_[0-9a-f]{24})$/;
export const ATTEMPT_UID_RE = /^att_1_[0-9a-f]{24}$/;
export const EXPLICIT_TEST_UID_RE = /^tc-[a-z0-9][a-z0-9._-]{0,47}$/;
export const DERIVED_TEST_UID_RE = /^tc_1_d_[0-9a-f]{16}$/;
export const PROVISIONAL_TEST_UID_RE = /^tcp_1_[0-9a-f]{16}_[0-9]{1,3}$/;
export const TEST_UID_RE = new RegExp(
  `^(?:${EXPLICIT_TEST_UID_RE.source.slice(1, -1)}|${DERIVED_TEST_UID_RE.source.slice(1, -1)}|${PROVISIONAL_TEST_UID_RE.source.slice(1, -1)})$`
);

export const isProjectUid = (v) => typeof v === 'string' && PROJECT_UID_RE.test(v);
export const isRunUid = (v) => typeof v === 'string' && RUN_UID_RE.test(v);
export const isAttemptUid = (v) => typeof v === 'string' && ATTEMPT_UID_RE.test(v);
export const isTestUid = (v) => typeof v === 'string' && TEST_UID_RE.test(v);
export const isLegacyProjectUid = (v) => typeof v === 'string' && /^proj_[0-9a-f-]{36}$/.test(v);
export const isLegacyRunUid = (v) => typeof v === 'string' && /^run_[0-9a-f-]{36}$/.test(v);

/** An explicit UID annotation inside a test title, e.g. `@TC-001`. */
const EXPLICIT_ANNOTATION_RE = /@TC-([A-Za-z0-9][A-Za-z0-9._-]{0,47})/i;

/* ------------------------------------------------------------------ */
/* Project                                                             */
/* ------------------------------------------------------------------ */

/**
 * Canonical seed of a project: the resolved absolute root path, with the
 * separator normalised and the case folded on the platforms whose default
 * filesystem is case insensitive. The seed deliberately excludes the project
 * name and the Git remote so that the UID stays recomputable from the state
 * file alone, which is what the migration script needs.
 */
export function projectSeed(root) {
  const normalized = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const folded = process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
  return folded;
}

/** Stable UID of a project: `proj_1_<24 hex>`. */
export function projectUidFor(root) {
  return `proj_1_${sha256(projectSeed(root)).slice(0, 24)}`;
}

/**
 * The UID seed used for TestDefinition derivation. It is the project UID
 * whenever the project already runs on this scheme, and the recomputed UID
 * for a legacy project, so that test UIDs stay identical across the
 * migration of the project identifier itself.
 */
export function projectUidOf(project) {
  if (!project) return null;
  if (isProjectUid(project.id) && !isLegacyProjectUid(project.id)) return project.id;
  return projectUidFor(project.root);
}

/* ------------------------------------------------------------------ */
/* TestDefinition: keys and derivation                                 */
/* ------------------------------------------------------------------ */

/** Explicit UID declared by the author, e.g. `@TC-001` -> `tc-001`. */
export function extractExplicitUid(title) {
  const m = EXPLICIT_ANNOTATION_RE.exec(String(title ?? ''));
  return m ? `tc-${m[1].toLowerCase()}` : null;
}

/**
 * Normalised title used as the derivation basis. The explicit UID
 * annotation is removed so that adding or removing `@TC-xxx` does not change
 * the derived key, and the result is case folded so that a retitled case is
 * still recognised.
 */
export function normalizeTitleKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .replace(EXPLICIT_ANNOTATION_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Whitespace collapsed body text; used as the secondary identity signal. */
export function normalizeBodyText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Body fingerprint of one test case. `null` when the body is unavailable. */
export function bodyKeyOf(bodyText) {
  if (bodyText === null || bodyText === undefined) return null;
  return sha256(normalizeBodyText(bodyText));
}

/** Derived UID of a test case from a basis key (title key or body key). */
export function deriveTestUid(projectUid, basisKey) {
  return `tc_1_d_${sha256(`${projectUid}${NUL}${basisKey}`).slice(0, 16)}`;
}

/** Provisional UID for a test case whose identity cannot be pinned down. */
export function provisionalTestUid(projectUid, file, title, line, ordinal) {
  const basis = sha256(`${projectUid}${NUL}${file}${NUL}${title}${NUL}${line}`).slice(0, 16);
  return `tcp_1_${basis}_${ordinal}`;
}

/* ------------------------------------------------------------------ */
/* TestDefinition: body extraction                                     */
/* ------------------------------------------------------------------ */

const REGEX_ALLOWED_BEFORE = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%',
  '<', '>', '~', '^', '\n'
]);

/**
 * True when a `/` at `i` opens a regular expression literal.
 *
 * Exported because the lexical readers of the discovery modules have to
 * agree with the body extraction on what a regular expression is. Two
 * lexers that disagree would read different code as a string and different
 * code as a pattern.
 */
export function regexAllowedAt(src, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') continue;
    return REGEX_ALLOWED_BEFORE.has(c);
  }
  return true;
}

function skipLineComment(src, i) {
  while (i < src.length && src[i] !== '\n') i++;
  return i;
}

function skipBlockComment(src, i) {
  i += 2;
  while (i < src.length) {
    if (src[i] === '*' && src[i + 1] === '/') return i + 2;
    i++;
  }
  return i;
}

export function skipQuoted(src, i, quote) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}

export function skipTemplate(src, i) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '"' || ch === "'") { i = skipQuoted(src, i, ch); continue; }
        else if (ch === '`') { i = skipTemplate(src, i); continue; }
        else if (ch === '/' && src[i + 1] === '/') { i = skipLineComment(src, i); continue; }
        else if (ch === '/' && src[i + 1] === '*') { i = skipBlockComment(src, i); continue; }
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

export function skipRegexLiteral(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i + 1;
    else if (c === '\n') return i;
    i++;
  }
  return i;
}

function skipSpace(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

/** Extracts one argument of a call expression starting at `i`. */
function scanArgument(src, i) {
  const start = i;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = skipLineComment(src, i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = skipBlockComment(src, i); continue; }
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/' && regexAllowedAt(src, i)) { i = skipRegexLiteral(src, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
      i++;
      continue;
    }
    if (c === ',' && depth === 0) break;
    i++;
  }
  return { text: src.slice(start, i), end: i };
}

/**
 * Body of the test callback that follows the title literal.
 * `afterTitle` is the index right behind the closing quote of the title.
 * Returns `{text:null}` when the call has no further argument or when the
 * body exceeds `maxLength`; a missing body degrades the identity signal but
 * never breaks discovery.
 */
export function extractCallbackBody(content, afterTitle, maxLength = 200000) {
  const src = String(content ?? '');
  let i = skipSpace(src, afterTitle);
  if (src[i] !== ',') return { text: null, reason: 'no-callback' };
  i = skipSpace(src, i + 1);
  const { text } = scanArgument(src, i);
  if (text.length > maxLength) return { text: null, reason: 'body-too-large' };
  return { text, reason: null };
}

/* ------------------------------------------------------------------ */
/* Test cases: the source scanner                                      */
/* ------------------------------------------------------------------ */

/** The modifiers a test call may carry. */
const CALL_MODIFIERS = new Set(['only', 'skip', 'fixme']);

/** True for the characters an identifier may start with. */
const IDENT_START_RE = /[A-Za-z_$]/;
/** True for the characters an identifier may continue with. */
const IDENT_PART_RE = /[A-Za-z0-9_$]/;

/**
 * The positions of the line breaks of a source.
 *
 * They are counted once per file, so that the line of a call is a binary
 * search instead of a scan of the whole prefix of the file.
 */
function newlineOffsets(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') out.push(i);
  return out;
}

/** The line (1-based) the character at `index` sits on. */
function lineAt(offsets, index) {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * Decodes the escape sequences of a string literal.
 *
 * Only the escapes a test title realistically carries are decoded; an
 * unknown escape yields the escaped character itself, which is what
 * JavaScript does for a non-standard escape in a string.
 */
function decodeEscapes(raw) {
  if (!raw.includes('\\')) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue; }
    const e = raw[i + 1];
    if (e === undefined) { out += '\\'; break; }
    if (e === 'n') out += '\n';
    else if (e === 't') out += '\t';
    else if (e === 'r') out += '\\r';
    else out += e;
    i++;
  }
  return out;
}

/**
 * The title literal at `i`, decoded.
 *
 * The DECODED value is what the source MEANS: `test('user\'s profile')` is
 * the title `user's profile`. The scanner used to cut the title at the first
 * quote -- escaped or not -- so it read `user\`, a title the CLI never
 * reports. The two indexes then derived different UIDs from the same case,
 * and switching between them moved the UID of every case with an escape in
 * its title.
 *
 * A template literal is read as it is WRITTEN: the scanner cannot know what
 * a template renders to, and the template is what the static index reports.
 *
 * Returns null when there is no literal at `i`.
 */
export function readTitleLiteral(src, i) {
  const quote = src[i];
  if (quote === '`') {
    const end = skipTemplate(src, i);
    if (end <= i + 1) return null;
    return { value: src.slice(i + 1, end - 1), end };
  }
  if (quote !== '"' && quote !== "'") return null;
  const end = skipQuoted(src, i, quote);
  if (end <= i + 1) return null;
  return { value: decodeEscapes(src.slice(i + 1, end - 1)), end };
}

/**
 * Skips a quoted literal, but only when it is closed on its own line.
 *
 * A quote that never closes would otherwise swallow the rest of the file --
 * and with it every test case in it. A literal that is not closed on its
 * line is not a literal, so the scan simply steps over the quote.
 */
export function skipStringLiteral(src, i, quote) {
  const end = skipQuoted(src, i, quote);
  if (end >= src.length || src.indexOf('\n', i) < end) return i + 1;
  return end;
}

/**
 * The test call that starts with the identifier at [wordStart, wordEnd).
 *
 * Returns null when the identifier is not a call the scanner indexes.
 */
function readTestCall(src, wordStart, wordEnd, newlines) {
  // The call must OPEN A LINE: only whitespace may precede it. That is the
  // restriction the first scanner had, and it keeps a `test` that is a
  // property or a variable out of the index.
  const lineStart = src.lastIndexOf('\n', wordStart - 1) + 1;
  for (let k = lineStart; k < wordStart; k++) {
    const c = src[k];
    if (c !== ' ' && c !== '\t') return null;
  }
  let i = wordEnd;
  // An optional modifier: `test.only(`, `test.skip(`, `test.fixme(`.
  let j = i;
  while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
  if (src[j] === '.') {
    let k = j + 1;
    while (k < src.length && IDENT_PART_RE.test(src[k])) k++;
    if (CALL_MODIFIERS.has(src.slice(j + 1, k))) i = k;
  }
  // The opening parenthesis, then the title argument.
  let k = i;
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] !== '(') return null;
  let m = k + 1;
  while (m < src.length && /\s/.test(src[m])) m++;
  const literal = readTitleLiteral(src, m);
  if (!literal) return null;
  return {
    title: literal.value,
    // The line of the CALL, not of the title. A Playwright report numbers
    // the call, and a call whose title sits on the next line has to be
    // found at the position the CLI reports -- otherwise the case is not
    // recognised as a source case and its identity stops being tracked
    // across a retitle.
    line: lineAt(newlines, wordStart),
    afterTitle: literal.end,
    end: literal.end
  };
}

/**
 * The test calls of a source file, in the order they appear.
 *
 * The scanner walks the file with the same restricted lexer the body
 * extraction uses: strings, template literals, comments and regular
 * expressions are SKIPPED, so a `test(` that only appears inside one of
 * them is not indexed.
 */
function findTestCalls(src) {
  const calls = [];
  const n = src.length;
  const newlines = newlineOffsets(src);
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = skipLineComment(src, i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = skipBlockComment(src, i); continue; }
    if (c === '"' || c === "'") { i = skipStringLiteral(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/' && regexAllowedAt(src, i)) { i = skipRegexLiteral(src, i); continue; }
    if (IDENT_START_RE.test(c)) {
      const start = i;
      while (i < n && IDENT_PART_RE.test(src[i])) i++;
      const word = src.slice(start, i);
      if (word === 'test' || word === 'it') {
        const call = readTestCall(src, start, i, newlines);
        if (call) { calls.push(call); i = call.end; continue; }
      }
      continue;
    }
    i++;
  }
  return calls;
}

/**
 * Scans one source file for the test cases it declares.
 *
 * The scanner recognises the common `test()` / `it()` forms, including the
 * `.only` / `.skip` / `.fixme` modifiers. For every case it reports the
 * title, the line of the CALL (a Playwright report numbers the call, not the
 * whitespace in front of it) and the text of the callback body.
 *
 * The title is the title the source MEANS: it is read as a literal, so an
 * escape inside it is decoded, and it is NOT cut to a fixed length. A title
 * that is cut or mis-read is a title the CLI does not report, and the UID
 * derived from it is therefore a UID the other index cannot reproduce.
 *
 * It is pure: it reads the source text that is handed to it and touches
 * nothing else.
 */
export function scanTestCases(content) {
  const src = String(content ?? '');
  const cases = [];
  for (const call of findTestCalls(src)) {
    const body = extractCallbackBody(src, call.afterTitle);
    cases.push({ title: call.title, line: call.line, bodyText: body.text });
  }
  return cases;
}

/* ------------------------------------------------------------------ */
/* TestDefinition: identity resolution                                */
/* ------------------------------------------------------------------ */

export const emptyRegistry = () => ({ version: UID_SCHEME_VERSION, projects: {} });

const registryOf = (registry, projectUid) => {
  const entry = registry?.projects?.[projectUid];
  return entry && Array.isArray(entry.entries) ? entry : { version: UID_SCHEME_VERSION, entries: [] };
};

/** The title key of a registry entry (computed when the entry has none). */
const titleKeyOf = (entry) => entry.titleKey ?? normalizeTitleKey(entry.title);

/** The DISTINCT uids of a list of registry entries. */
const distinctUids = (entries) => [...new Set(entries.map((e) => e.uid).filter(Boolean))];

/**
 * Matches one discovered case against the UID registry.
 *
 * The registry is a MEMORY of the cases seen before, so it can hold stale
 * entries: an entry whose case was renamed, retitled, duplicated or deleted.
 * A stale entry must not decide the identity of a case forever, and it must
 * never hand a uid to a DIFFERENT case.
 *
 * The matching therefore works in this order:
 *
 *   1. the entries with the same body key that also sit at the same position
 *      (same file, same title key) -- the most precise signal;
 *   2. the entries with the same body key, but only when that body key is
 *      unique inside the project -- a body shared by several cases does not
 *      identify one of them;
 *   3. nothing.
 *
 * A uid that an explicit `@TC-` annotation claims for another case is never
 * handed out: the annotation is the author's own statement about the case.
 *
 * Returns `{uid, entry, conflict}`. `conflict` is non-null when the registry
 * could not decide -- the caller reports it instead of silently dropping it.
 */
function matchRegistry(it, { registryByBody, bodyCounts, reserved }) {
  const hits = it.bodyKey ? (registryByBody.get(it.bodyKey) ?? []) : [];
  if (!hits.length) return { uid: null, entry: null, conflict: null };

  const narrowed = hits.filter((h) => h.file === it.file && titleKeyOf(h) === it.titleKey);
  let pool = narrowed;
  if (!pool.length) {
    // The case may have moved to another file or been retitled. That is only
    // safe when the body key is unique inside the project.
    if (bodyCounts.get(it.bodyKey) !== 1) {
      return {
        uid: null,
        entry: null,
        conflict: { reason: 'ambiguous-registry-match', candidates: distinctUids(hits) }
      };
    }
    pool = hits;
  }

  const uids = distinctUids(pool);
  if (uids.length !== 1) {
    return { uid: null, entry: null, conflict: { reason: 'ambiguous-registry-match', candidates: uids } };
  }
  const uid = uids[0];
  if (reserved.has(uid)) {
    return {
      uid: null,
      entry: null,
      conflict: { reason: 'explicit-uid-claimed-by-another-case', candidates: [uid] }
    };
  }
  return { uid, entry: pool.find((h) => h.uid === uid), conflict: null };
}

/**
 * Resolves the stable UID of every discovered test case.
 *
 * `discovered` items: `{file, title, line, bodyText}`.
 * `registry` entries: `{uid, uidSource, titleKey, bodyKey, file, title, aliases}`.
 *
 * Precedence per test case:
 *   1. explicit annotation `@TC-<token>`  -> always stable
 *   2. registry match on the body key     -> stable across rename and retitle
 *   3. derived from the title key         -> stable across rename
 *   4. derived from the body key          -> used when the title is duplicated
 *   5. provisional                        -> not stable, ambiguity is reported
 *
 * Two test cases are the same logical case when they carry the same explicit
 * UID, or when their body keys are equal and that body key is unique inside
 * the project. Equal titles with different bodies are different cases.
 *
 * A duplicated explicit annotation is NOT silently resolved: both cases end
 * up in the ambiguity report, because the author wrote down the same uid twice
 * and only the author can say which case it belongs to.
 */
export function resolveIdentities({ projectUid, discovered, registry, scope = null, duplicateExplicitUids = null, extraCandidates = null, claimedExplicitUids = null }) {
  const reg = registryOf(registry, projectUid);
  const items = discovered.map((d) => ({
    ...d,
    titleKey: normalizeTitleKey(d.title),
    bodyKey: bodyKeyOf(d.bodyText ?? null),
    explicitUid: extractExplicitUid(d.title)
  }));

  const titleCounts = new Map();
  const bodyCounts = new Map();
  for (const it of items) {
    titleCounts.set(it.titleKey, (titleCounts.get(it.titleKey) ?? 0) + 1);
    if (it.bodyKey) bodyCounts.set(it.bodyKey, (bodyCounts.get(it.bodyKey) ?? 0) + 1);
  }

  // The explicit annotations are CLAIMS: the uid an author wrote down belongs
  // to the case that carries it, and no registry entry may hand it to another
  // case.
  const explicitOwners = new Map();
  for (const it of items) {
    if (!it.explicitUid) continue;
    if (!explicitOwners.has(it.explicitUid)) explicitOwners.set(it.explicitUid, []);
    explicitOwners.get(it.explicitUid).push(it);
  }
  const reserved = new Set(explicitOwners.keys());
  // ATS-602: a token that ANY case of the catalogue declares is reserved as
  // well -- a mobile case the caller knows about, not only a web case of
  // this list. The registry may remember a token under the body of a case
  // that has since dropped it, and handing it back would give two cases
  // one uid. The caller passes the tokens every case of the whole
  // catalogue declares; a missing or non-Set value adds nothing.
  if (claimedExplicitUids instanceof Set) {
    for (const uid of claimedExplicitUids) reserved.add(uid);
  }

  // A token that ANOTHER ENGINE claims as well is claimed by nobody. The
  // caller knows the whole catalogue -- the web cases and the mobile ones --
  // and passes the tokens that more than one case claims. Both sides then
  // give the token up.
  const claimedElsewhere = duplicateExplicitUids instanceof Set ? duplicateExplicitUids : new Set();
  const isDuplicated = (uid) => (explicitOwners.get(uid)?.length ?? 0) > 1 || claimedElsewhere.has(uid);

  const registryByBody = new Map();
  for (const e of reg.entries) {
    if (!e.bodyKey || !e.uid) continue;
    if (!registryByBody.has(e.bodyKey)) registryByBody.set(e.bodyKey, []);
    registryByBody.get(e.bodyKey).push(e);
  }

  const candidates = items.map((it) => {
    if (it.explicitUid) {
      if (isDuplicated(it.explicitUid)) {
        // The same annotation on two cases: neither may claim it.
        return {
          ...it,
          uid: null,
          uidSource: 'provisional',
          uidStable: false,
          matched: null,
          basis: null,
          duplicateExplicit: it.explicitUid
        };
      }
      return { ...it, uid: it.explicitUid, uidSource: 'explicit', uidStable: true, matched: null, basis: 'explicit' };
    }
    const match = matchRegistry(it, { registryByBody, bodyCounts, reserved });
    if (match.uid) {
      return {
        ...it,
        uid: match.uid,
        uidSource: 'registry',
        uidStable: true,
        matched: { uid: match.uid, previousTitle: match.entry.title ?? null, previousFile: match.entry.file ?? null },
        basis: 'body-key'
      };
    }
    if (titleCounts.get(it.titleKey) === 1) {
      return {
        ...it,
        uid: deriveTestUid(projectUid, it.titleKey),
        uidSource: 'derived',
        uidStable: true,
        matched: null,
        basis: 'title-key',
        ...(match.conflict ? { registryConflict: match.conflict } : {})
      };
    }
    if (it.bodyKey && bodyCounts.get(it.bodyKey) === 1) {
      return {
        ...it,
        uid: deriveTestUid(projectUid, it.bodyKey),
        uidSource: 'derived-body',
        uidStable: true,
        matched: null,
        basis: 'body-key',
        ...(match.conflict ? { registryConflict: match.conflict } : {})
      };
    }
    return {
      ...it,
      uid: null,
      uidSource: 'provisional',
      uidStable: false,
      matched: null,
      basis: null,
      ...(match.conflict ? { registryConflict: match.conflict } : {})
    };
  });

  // Collision resolution: two candidates may want the same UID. The claim that
  // is backed by the registry keeps it, every other claim falls back to the
  // body key and finally to a provisional identifier.
  //
  // An EXPLICIT claim is never taken away: the author wrote the uid down, so
  // it is the explicit claim that wins over a derived or a registry claim.
  const claims = new Map();
  for (const c of candidates) {
    if (!c.uid) continue;
    if (!claims.has(c.uid)) claims.set(c.uid, []);
    claims.get(c.uid).push(c);
  }
  for (const [uid, group] of claims) {
    if (group.length < 2) continue;
    const winner = group.find((g) => g.uidSource === 'explicit')
      ?? group.find((g) => g.uidSource === 'registry')
      ?? null;
    for (const c of group) {
      if (winner && c === winner) continue;
      const fallback = c.bodyKey && bodyCounts.get(c.bodyKey) === 1
        ? deriveTestUid(projectUid, c.bodyKey)
        : null;
      c.uid = fallback && fallback !== uid ? fallback : null;
      c.uidSource = fallback ? 'derived-body' : 'provisional';
      c.uidStable = Boolean(fallback);
    }
  }

  // Provisional identifiers and the ambiguity report.
  //
  // Three kinds of ambiguity are reported, none of them silently dropped:
  //   * a duplicated EXPLICIT annotation -- the author wrote the same uid on
  //     two cases;
  //   * identical titles (and bodies) -- the case cannot be pinned down;
  //   * a registry conflict -- the memory of the past cases does not decide.
  const ambiguousGroups = new Map();
  for (const c of candidates) {
    if (c.uid) continue;
    const key = c.duplicateExplicit ? `explicit:${c.duplicateExplicit}` : c.titleKey;
    if (!ambiguousGroups.has(key)) ambiguousGroups.set(key, []);
    ambiguousGroups.get(key).push(c);
  }
  for (const [key, group] of ambiguousGroups) {
    group.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    const duplicateExplicit = group[0]?.duplicateExplicit ?? null;
    group.forEach((c, index) => {
      c.uid = provisionalTestUid(projectUid, c.file, c.title, c.line, index + 1);
      c.uidSource = 'provisional';
      c.uidStable = false;
      c.ambiguity = {
        key,
        reason: duplicateExplicit
          ? 'duplicate-explicit-uid'
          : (c.bodyKey ? 'identical-title-and-body' : 'identical-title'),
        ...(duplicateExplicit ? { explicitUid: duplicateExplicit } : {}),
        candidates: group.map((g) => ({ file: g.file, title: g.title, line: g.line }))
      };
    });
  }

  // A registry conflict is reported on the case it happened to, even when the
  // case itself could be given a uid: the conflict means the MEMORY of the
  // past cases is inconsistent, and a reader has to know about it.
  for (const c of candidates) {
    if (!c.registryConflict || c.ambiguity) continue;
    c.ambiguity = {
      key: c.titleKey,
      reason: c.registryConflict.reason,
      candidates: (c.registryConflict.candidates ?? []).map((uid) => ({ uid }))
    };
  }

  const entries = mergeRegistry(reg, [...candidates, ...(extraCandidates ?? [])], scope);
  return { items: candidates, registry: { version: UID_SCHEME_VERSION, projects: { ...(registry?.projects ?? {}), [projectUid]: entries } } };
}

/**
 * Merges the resolved cases into the UID registry.
 *
 * The registry must stay BOUNDED and UNIQUE:
 *
 *   * one entry per uid -- two entries with the same uid would make every
 *     later lookup ambiguous, even though they describe the same case;
 *   * one entry per (uid) rather than per (uid, body key) -- an entry whose
 *     body changed is UPDATED, not duplicated;
 *   * stale entries are PRUNED -- an entry whose uid no longer belongs to any
 *     discovered case would keep a deleted case alive forever and could hand
 *     its uid to a different case later on.
 */
function mergeRegistry(reg, candidates, scope = null) {
  const entries = reg.entries.slice();
  const byBody = new Map();
  const byUid = new Map();
  for (const e of entries) {
    if (e.uid && !byUid.has(e.uid)) byUid.set(e.uid, e);
    if (!e.bodyKey) continue;
    if (!byBody.has(e.bodyKey)) byBody.set(e.bodyKey, []);
    byBody.get(e.bodyKey).push(e);
  }
  for (const c of candidates) {
    if (!c.bodyKey || !c.uid) continue;
    const hits = byBody.get(c.bodyKey) ?? [];
    // Several cases may share a body key (identical bodies). The registry
    // entry is chosen by the position inside the file, so that two cases
    // with the same title and the same body keep their own identity.
    let existing = hits.find((e) => e.uid === c.uid);
    if (!existing && hits.length > 1) {
      const sameFile = hits.filter((e) => e.file === c.file);
      if (sameFile.length === 1) existing = sameFile[0];
    }
    // ONE ENTRY PER UID. The uid may be remembered under ANOTHER body: an
    // explicit token that moved to a case with a different body (a web
    // case that took over a token a mobile scenario dropped, for one).
    // The entry is then UPDATED to the new body and position, not
    // duplicated -- a second entry with the same uid would keep the OLD
    // position alive and make every later lookup ambiguous.
    if (!existing) existing = byUid.get(c.uid) ?? null;
    if (existing) {
      if (existing.bodyKey !== c.bodyKey) {
        const bucket = byBody.get(existing.bodyKey) ?? [];
        const at = bucket.indexOf(existing);
        if (at >= 0) bucket.splice(at, 1);
        if (!byBody.has(c.bodyKey)) byBody.set(c.bodyKey, []);
        byBody.get(c.bodyKey).push(existing);
      }
      if (existing.file !== c.file || existing.title !== c.title) {
        existing.aliases = existing.aliases ?? [];
        if (!existing.aliases.some((a) => a.file === existing.file && a.title === existing.title)) {
          existing.aliases.push({ file: existing.file, title: existing.title });
        }
        existing.file = c.file;
        existing.title = c.title;
      }
      existing.titleKey = c.titleKey;
      existing.uidSource = c.uidSource;
      existing.line = c.line;
      existing.bodyKey = c.bodyKey;
      existing.duplicateExplicit = c.duplicateExplicit ?? null;
      continue;
    }
    const entry = {
      uid: c.uid,
      uidSource: c.uidSource,
      titleKey: c.titleKey,
      bodyKey: c.bodyKey,
      file: c.file,
      title: c.title,
      line: c.line,
      aliases: [],
      // ATS-204: the verdict of the catalogue on the explicit token this
      // case carries. The static index judges the token duplicated in the
      // project (two cases wrote down the same `@TC-xxx`), and the RUN side
      // has to agree with that judgement: a run that covers only one of the
      // two files would otherwise bind the token to one of them, and the two
      // cases would end up with the same UID.
      //
      // The verdict is written on the ENTRY, because the entry is what the
      // run side reads. The candidate alone does not reach it -- the run
      // side never sees the candidates, it sees the registry.
      duplicateExplicit: c.duplicateExplicit ?? null,
    };
    entries.push(entry);
    byUid.set(entry.uid, entry);
    if (!byBody.has(c.bodyKey)) byBody.set(c.bodyKey, []);
    byBody.get(c.bodyKey).push(entry);
  }
  return { version: UID_SCHEME_VERSION, entries: pruneRegistry(entries, candidates, scope) };
}

/**
 * Prunes the registry down to the entries that still describe a live case.
 *
 * An entry is kept when its uid is claimed by one of the resolved cases. An
 * entry whose uid is not claimed any more belonged to a case that was deleted
 * or whose identity was taken over by another case: keeping it would let a
 * stale uid be handed out later, and it would grow the state file without
 * bound.
 *
 * The pruning is what makes a stale entry stop blocking rule 2: without it a
 * deleted case keeps its body key forever and every later case with the same
 * body is reported as ambiguous.
 *
 * ABSENCE IS NOT DELETION. An entry is only pruned when the file it belongs to
 * was part of THIS discovery and the case is gone from that file. A file that
 * is not in the discovery at all -- a branch that does not contain it, a file
 * that was moved, a project that is discovered in pieces -- says nothing about
 * the cases inside it. Pruning such an entry would drop the identity of a case
 * that still exists, and the case would come back with a NEW uid after the
 * file returns.
 *
 * `scope` is the set of files this discovery covered. An entry whose file is
 * outside the scope is kept, whatever its uid.
 *
 * It is exported because the ATS-202 authoritative discovery prunes the
 * registry with the SAME rule: an entry is dropped only when its file was
 * part of THIS discovery and no resolved case claims its uid.
 */
export function pruneRegistry(entries, candidates, scope = null) {
  const live = new Set(candidates.map((c) => c.uid).filter(Boolean));
  const inScope = (e) => scope === null || scope.has(e.file);
  const kept = entries.filter((e) => !e.uid || live.has(e.uid) || !inScope(e));
  // Two entries with the same uid describe the same case; the later one wins
  // so that the newest position (file / title / line) is the one kept.
  const byUid = new Map();
  const result = [];
  for (const e of kept) {
    if (!e.uid) { result.push(e); continue; }
    if (!byUid.has(e.uid)) byUid.set(e.uid, e);
  }
  for (const e of kept) {
    if (!e.uid) continue;
    if (byUid.get(e.uid) === e) result.push(e);
  }
  return result;
}

/**
 * Decides whether two discovered test cases denote the same logical case.
 * Returns the basis so that callers can explain the decision.
 */
export function compareIdentities(a, b) {
  const aExplicit = extractExplicitUid(a.title);
  const bExplicit = extractExplicitUid(b.title);
  if (aExplicit && bExplicit) {
    return aExplicit === bExplicit
      ? { same: true, basis: 'explicit-uid' }
      : { same: false, basis: 'different-explicit-uid' };
  }
  const aBody = bodyKeyOf(a.bodyText ?? null);
  const bBody = bodyKeyOf(b.bodyText ?? null);
  const aTitle = normalizeTitleKey(a.title);
  const bTitle = normalizeTitleKey(b.title);
  if (aBody && aBody === bBody) return { same: true, basis: 'body-key' };
  if (aTitle && aTitle === bTitle) return { same: false, basis: 'same-title-different-body' };
  return { same: false, basis: 'different' };
}

/* ------------------------------------------------------------------ */
/* Run and Attempt                                                     */
/* ------------------------------------------------------------------ */

/** Normalised target selector of a run: a relative file or `*` for all. */
export function targetKey(file) {
  return file ? String(file).replace(/\\/g, '/') : '*';
}

/**
 * Normalised project relative path of a test file.
 *
 * The registry stores the file relative to the project root (`tests/a.spec.ts`)
 * while a Playwright report names it relative to its own `rootDir`, which is
 * derived from `testDir` (`a.spec.ts`). Both spellings have to be reduced to
 * the same key before they can be compared, otherwise a reported case never
 * matches its registry entry.
 *
 * `rootDir` is the directory the reported path is relative to. When it is
 * known, the reported path is resolved against it and then made relative to
 * the project root; when it is not, the path is only normalised (separators,
 * `./` prefix, duplicate slashes).
 */
export function normalizeTestPath(file, { rootDir = null, projectRoot = null } = {}) {
  let p = String(file ?? '').replace(/\\/g, '/');
  if (!p) return '';
  if (path.isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    if (!projectRoot) return p.replace(/^\.\//, '');
    const rel = path.relative(projectRoot, p).replace(/\\/g, '/');
    return rel.startsWith('..') ? p : rel;
  }
  if (rootDir && projectRoot) {
    const abs = path.resolve(rootDir, p).replace(/\\/g, '/');
    const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
    if (!rel.startsWith('..')) return rel;
  }
  return p.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/**
 * Stable UID of a run: `run_1_<24 hex>`.
 * `seq` is the per project execution sequence. It makes every execution of
 * the same target at the same commit distinguishable while keeping the UID
 * reproducible from the recorded run fields.
 */
export function runUidFor({ projectUid, gitCommit, file, seq }) {
  const basis = [projectUid, gitCommit || '', targetKey(file), String(seq)].join(NUL);
  return `run_1_${sha256(basis).slice(0, 24)}`;
}

/**
 * Stable UID of one attempt of one test case inside a run.
 *
 * The basis is the run, the test case, the retry index and the occurrence
 * index of the case inside the report. The occurrence index is what keeps
 * two attempts distinct when they refer to the same case: a retried case
 * produces one attempt per retry, and a report that lists the same case
 * twice (the same file, the same title and the same line) still produces two
 * distinct attempts instead of two records with the same identifier.
 */
export function attemptUidFor({ runUid, testUid, retry, fallbackKey, occurrence }) {
  const basis = [runUid, testUid || fallbackKey || '', String(retry ?? 0), String(occurrence ?? 0)].join(NUL);
  return `att_1_${sha256(basis).slice(0, 24)}`;
}

/* ------------------------------------------------------------------ */
/* Registry lookup                                                    */
/* ------------------------------------------------------------------ */

/**
 * Finds the TestDefinition UID of a case reported by a test runner.
 *
 * The lookup walks from the most precise signal to the least precise one:
 *
 *   1. the same file and the same line  -- the case did not move;
 *   2. the same file and the same title -- the case was retitled in place;
 *   3. the same title alone            -- the case moved to another file;
 *   4. no match                         -- the case is not in the registry.
 *
 * Step 1 is only trusted when the TITLE agrees as well. A line number alone is
 * not an identity: the source may have changed between the discovery and the
 * run (a case inserted above shifts every later line), and binding a reported
 * case to the registry entry that happens to sit at that line would attach the
 * run to the WRONG logical case -- silently, because nothing looks wrong.
 * So a file-line hit whose title does not match is not a hit; the lookup
 * falls through to the title-based steps, which are position independent.
 *
 * A title that several cases in the same file share is not an identity
 * either, and the line cannot make it one: the case that sits at the reported
 * line TODAY may be a different case than the one that sat there when the
 * registry was written. Such a group is only bound when the BODY FINGERPRINT
 * of the reported case singles out one entry -- the body is what tells two
 * same-titled cases apart. `bodyKey` carries that fingerprint; `resolveBodyKey`
 * computes it on demand, so the source file is only read when the group is
 * actually ambiguous.
 *
 * Steps 2 and 3 only match when the signal is unambiguous: if two registry
 * entries share the signal, the case is reported as unbound rather than
 * bound to an arbitrary entry. Uniqueness is counted over the DISTINCT uids,
 * so two entries that describe the same case do not make the lookup ambiguous.
 *
 * Returns `{uid, basis, candidates}`.
 */
export function findTestUid(registry, projectUid, { file, title, line, bodyKey = null, resolveBodyKey = null }) {
  const entries = registry?.projects?.[projectUid]?.entries ?? [];
  const byFileLine = new Map();
  const byFileTitle = new Map();
  const byTitle = new Map();
  for (const e of entries) {
    if (!e.uid) continue;
    if (Number.isInteger(e.line) && e.line > 0) {
      const k = `${e.file} ${e.line}`;
      if (!byFileLine.has(k)) byFileLine.set(k, []);
      byFileLine.get(k).push(e);
    }
    const kt = `${e.file} ${e.title}`;
    if (!byFileTitle.has(kt)) byFileTitle.set(kt, []);
    byFileTitle.get(kt).push(e);
    if (!byTitle.has(e.title)) byTitle.set(e.title, []);
    byTitle.get(e.title).push(e);
  }

  const pick = (hits, basis) => {
    // Uniqueness is counted over the DISTINCT uids: two registry entries that
    // describe the same case are not an ambiguity.
    const uids = [...new Set(hits.map((h) => h.uid).filter(Boolean))];
    if (uids.length === 1) return { uid: uids[0], basis, candidates: uids.length };
    if (uids.length > 1) return { uid: null, basis: `${basis}-ambiguous`, candidates: uids.length };
    return { uid: null, basis: 'unbound', candidates: 0 };
  };

  // The entries that describe a case with this title in this file. The number
  // of DISTINCT uids among them says whether the title identifies the case on
  // its own: one means yes, several mean that only the body can.
  const sameFileTitle = byFileTitle.get(`${file} ${title}`) ?? [];
  const titleUids = [...new Set(sameFileTitle.map((h) => h.uid).filter(Boolean))];
  if (titleUids.length > 1) {
    // The body of the reported case is what tells the same-titled cases apart.
    // When the caller can compute it, the body decides -- and when the body
    // cannot be computed, nothing can: the case stays unbound instead of
    // being bound by position to a case it may not be.
    if (typeof resolveBodyKey === 'function' || bodyKey) {
      const key = bodyKey ?? resolveBodyKey();
      if (key) {
        const byBody = sameFileTitle.filter((h) => h.bodyKey === key);
        const uids = [...new Set(byBody.map((h) => h.uid).filter(Boolean))];
        if (uids.length === 1) return { uid: uids[0], basis: 'file-title-body', candidates: 1 };
        return {
          uid: null,
          basis: uids.length ? 'title-body-ambiguous' : 'title-body-unknown',
          candidates: uids.length
        };
      }
      return { uid: null, basis: 'file-title-ambiguous', candidates: titleUids.length };
    }
    // The caller does not match on bodies, so the positional signal is the
    // only evidence left, and it is used below.
  }

  if (Number.isInteger(line) && line > 0) {
    // The line is only an identity together with the title: a reported case
    // whose title differs from the registry entry at that line is a DIFFERENT
    // case, whatever the line says.
    const atLine = byFileLine.get(`${file} ${line}`) ?? [];
    const sameTitle = atLine.filter((h) => h.title === title);
    if (sameTitle.length) {
      const hit = pick(sameTitle, 'file-line');
      if (hit.uid) return hit;
      if (hit.basis === 'file-line-ambiguous') return hit;
    }
  }
  if (file !== undefined && file !== null) {
    const hit = pick(byFileTitle.get(`${file} ${title}`) ?? [], 'file-title');
    if (hit.uid) return hit;
    if (hit.basis === 'file-title-ambiguous') return hit;
  }
  const hit = pick(byTitle.get(title) ?? [], 'title');
  if (hit.uid) return hit;
  if (hit.basis === 'title-ambiguous') return hit;
  return { uid: null, basis: 'unbound', candidates: 0 };
}

/* ------------------------------------------------------------------ */
/* Run sequence                                                       */
/* ------------------------------------------------------------------ */

/**
 * Assigns the per project execution sequence to a list of runs.
 *
 * The sequence is the discriminator that distinguishes two executions of the
 * same target at the same commit, so it must be recorded on the run record
 * itself: a run that carries a recorded `seq` keeps it, and the UID can be
 * recomputed from the recorded fields alone.
 *
 * A run without a recorded `seq` was written before the UID scheme. It is
 * numbered by its chronological position inside the project (createdAt
 * ascending, ties broken by the position in the given list) and takes the
 * lowest sequence number that is still free.
 *
 * The input array is not modified; a new array is returned.
 */
export function assignRunSeqs(runs) {
  const groups = new Map();
  runs.forEach((run, index) => {
    const key = run.projectId ?? run.projectUid ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ run, index });
  });

  const seqByIndex = new Map();
  for (const group of groups.values()) {
    const hasSeq = (g) => Number.isInteger(g.run.seq) && g.run.seq > 0;
    const taken = new Set(group.filter(hasSeq).map((g) => g.run.seq));
    const missing = group.filter((g) => !hasSeq(g));
    missing.sort((a, b) => {
      const ta = a.run.createdAt ?? '';
      const tb = b.run.createdAt ?? '';
      return ta === tb ? a.index - b.index : (ta < tb ? -1 : 1);
    });
    let next = 1;
    for (const g of missing) {
      while (taken.has(next)) next++;
      seqByIndex.set(g.index, next);
      taken.add(next);
      next++;
    }
  }

  return runs.map((run, index) => {
    const seq = Number.isInteger(run.seq) && run.seq > 0 ? run.seq : seqByIndex.get(index);
    return { ...run, seq };
  });
}

/**
 * Next free execution sequence of a project.
 * `history` are the runs of that project, `counter` the durable counter kept
 * in the state file. The counter makes the sequence monotonic even when the
 * run history is trimmed, so a sequence number is never reused.
 */
export function nextRunSeq(history, counter) {
  const fromHistory = history.reduce((max, r) => Math.max(max, Number.isInteger(r.seq) ? r.seq : 0), 0);
  return Math.max(fromHistory, Number.isInteger(counter) ? counter : 0) + 1;
}
