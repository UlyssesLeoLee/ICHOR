#!/usr/bin/env node
/**
 * ATS-101 probe -- Scenario D
 *   The hardcoded default port 4577 must be listed COMPLETELY in
 *   docs/16-BASELINE-ADR.md §3.1, otherwise a port change silently breaks
 *   the UI or the CSP.
 *
 * This probe enumerates every occurrence of itself and compares the count
 * against the list written in the baseline document. A mismatch is a defect
 * in the document, not a style preference.
 *
 * Usage: node tools/ats101-probes/scenario-d-port-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO_ROOT } from './lib/bridge.mjs';

const PORT = '4577';

console.log('=== ATS-101 scenario D: hardcoded default-port audit ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log(`port      : ${PORT}`);
console.log('');

/** Directories that are not part of the shipped source. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'out', 'dist', 'target', 'test-results', 'playwright-report', '.multica']);
const SOURCE_EXT = new Set(['.mjs', '.js', '.ts', '.tsx', '.html', '.rs', '.json', '.md', '.ps1', '.sh', '.py']);

/**
 * Files that mention the port but do not hardcode it at runtime.
 * They are listed in the baseline document as non-runtime references and are
 * checked separately, so the audit must not count them as runtime hardcoding.
 */
const NON_RUNTIME = new Set([
  'start.ps1',            // launcher script: prints / opens a URL
  'start.sh',             // launcher script: prints a URL
  'tests/test-cases.json', // test-case data (input strings)
  'tools/generate_test_docs.py', // generator for tests/test-cases.json -- rewrites the old port
  // A verification script that NAMES the port in a comment to explain that a
  // host:port pair is not a file citation. The literal takes no effect at
  // runtime -- it is prose inside a regex's docstring -- so it belongs to the
  // display-only bucket, not to the runtime bucket.
  'tools/check_adr_citations.py',
]);

/**
 * Pure documentation. These files MENTION the port exactly like README.md
 * does, so they belong in the same category -- excluding docs/ wholesale
 * while counting README.md would be an inconsistent rule.
 *
 * 16 §3.1 states how many mentions this group carries, so the count is
 * asserted against the document. The set is derived from the tree rather than
 * hardcoded, so a new doc that mentions the port is picked up automatically.
 */
/**
 * The probe directory as a whole: every script in it names the port it
 * audits, so a port mention there is a MENTION, not a runtime hardcoding.
 * Treating the directory (rather than a hand-picked file list) keeps the
 * document and the probe in agreement about what belongs to this bucket --
 * a new probe script, or a port mention added to this README, must not be
 * reported as a runtime hardcoding site.
 */
const DOC_MENTION_DIRS = ['tools/ats101-probes', 'tools/ats501-probes', 'tools/ats502-probes'];
/**
 * Every Markdown file is prose, whatever directory it sits in, so a port
 * mention in one is never a runtime hardcoding. The extension is the rule --
 * a new CHANGELOG.md or NOTES.md at the repository root belongs to this
 * bucket exactly like a file under docs/ does.
 */
const DOC_MENTION_EXT = new Set(['.md']);

/** True for a path that is pure documentation (a mention, not a hardcoding). */
function isDocMention(rel) {
  if (DOC_MENTION_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) return true;
  return DOC_MENTION_EXT.has(path.extname(rel));
}

/**
 * Binary containers that embed the port in their cell data. They are scanned
 * separately, because a plain text scan of the file bytes does not see the
 * shared strings inside the zip container.
 */
const XLSX_FILES = ['test-cases.xlsx'];

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

const findings = [];
const nonRuntimeFindings = [];
const docMentionFindings = [];
for (const file of walk(REPO_ROOT)) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.includes(PORT)) return;
    const entry = {
      rel,
      line: i + 1,
      text: line.trim(),
      // A single line may name the port more than once, so the occurrence
      // count is tracked per line -- the document's counts are occurrences.
      occurrences: line.split(PORT).length - 1,
    };
    // Three buckets, in this order:
    //   1. runtime hardcoding -- the port value actually takes effect;
    //   2. documentation mention -- prose that names the port;
    //   3. non-runtime data mention -- data/scripts that only display it.
    if (isDocMention(rel)) docMentionFindings.push(entry);
    else if (NON_RUNTIME.has(rel)) nonRuntimeFindings.push(entry);
    else findings.push(entry);
  });
}

/**
 * Scan the xlsx containers for the port. The port lives in shared-string cell
 * data inside the zip, and the zip entries are DEFLATE-compressed, so the raw
 * container bytes do not contain it -- the parts have to be inflated first.
 * These files carry test-case input data, not runtime behaviour, so they
 * belong to the non-runtime list.
 */
function inflateZipEntries(buf) {
  const parts = [];
  // Locate the end-of-central-directory record, then walk the central directory.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return parts;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // Local header: the data starts after its own name + extra fields.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let text;
    try {
      text = (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
    } catch {
      text = raw.toString('latin1');
    }
    parts.push({ name, text });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return parts;
}

for (const rel of XLSX_FILES) {
  const full = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(full)) {
    console.log(`WARNING: ${rel} not found -- the audit scope no longer matches the repository.`);
    continue;
  }
  let total = 0;
  const partNames = [];
  for (const part of inflateZipEntries(fs.readFileSync(full))) {
    const c = part.text.split(PORT).length - 1;
    if (c) { total += c; partNames.push(`${part.name} (${c})`); }
  }
  if (total) {
    nonRuntimeFindings.push({
      rel,
      line: 0,
      text: `${total} occurrence(s) in the xlsx container: ${partNames.join(', ')}`,
    });
  }
}

console.log('--- RUNTIME hardcoding in shipped source ---');
for (const f of findings) {
  console.log(`  ${f.rel}:${f.line}  ${f.text.length > 110 ? f.text.slice(0, 110) + '...' : f.text}`);
}
console.log(`total = ${findings.length}`);
console.log('');

console.log('--- NON-runtime data mentions (data/scripts that only display it) ---');
for (const f of nonRuntimeFindings) {
  console.log(`  ${f.rel}:${f.line}  ${f.text.length > 100 ? f.text.slice(0, 100) + '...' : f.text}`);
}
console.log(`total = ${nonRuntimeFindings.length}`);
console.log('');

console.log('--- DOC mentions (prose that names the port) ---');
for (const f of docMentionFindings) {
  console.log(`  ${f.rel}:${f.line}  ${f.text.length > 100 ? f.text.slice(0, 100) + '...' : f.text}`);
}
console.log(`total = ${docMentionFindings.length}`);
console.log('');

const files = [...new Set(findings.map((f) => f.rel))].sort();
const nonRuntimeFiles = [...new Set(nonRuntimeFindings.map((f) => f.rel))].sort();
console.log('--- distinct RUNTIME files ---');
for (const f of files) console.log(`  ${f}`);
console.log('');

// --- documentation mentions -------------------------------------------------
// 16 §3.1 states how many mentions the (c) class carries. The (c) class is
// every MARKDOWN file in the tree plus the probe directories; the COUNTED
// scope is what the document states verbatim: "every .md file except this
// document itself and the probe directories". That number must come from the
// tree, not from prose.
//
// The scope is therefore .md files only. A probe SCRIPT (a .mjs under a
// probe directory) is a mention in the broad sense -- it names the port it
// audits -- but it is not part of the (c) class the document counts, and
// counting it would make the guard fail whenever a new probe is added.
const docMentions = docMentionFindings.filter(
  (f) => f.rel !== 'docs/16-BASELINE-ADR.md'
    && path.extname(f.rel) === '.md'
    && !DOC_MENTION_DIRS.some((d) => f.rel.startsWith(`${d}/`)),
);
const docMentionFiles = [...new Set(docMentions.map((f) => f.rel))].sort();
const docMentionOccurrences = docMentions.reduce((n, f) => n + f.occurrences, 0);
console.log('--- distinct DOC files (c) class, excluding 16 itself and the probe dir ---');
for (const f of docMentionFiles) {
  const n = docMentions.filter((m) => m.rel === f).reduce((a, m) => a + m.occurrences, 0);
  console.log(`  ${f} (${n})`);
}
console.log(`files = ${docMentionFiles.length}, mentions = ${docMentionOccurrences}`);
console.log('');

// --- compare against the list in the baseline document -----------------------
const baseline = fs.readFileSync(path.join(REPO_ROOT, 'docs', '16-BASELINE-ADR.md'), 'utf8');
const section = baseline.split('### 3.1 HTTP 接口面')[1]?.split('### 3.2')[0] ?? '';

/**
 * Only the numbered "hardcoded port" item is the list under audit. The rest of
 * §3.1 (the endpoint table, other constraints) mentions other files, and
 * scanning it would produce false positives.
 */
const portItem = section.split(/\n1\. \*\*默认端口/)[1]?.split(/\n2\. /)[0] ?? '';
if (!portItem) {
  console.log('RESULT: MISMATCH -- could not locate the numbered port list in 16 §3.1.');
  process.exitCode = 1;
}

/** `file:line` or `file` references inside the port list. */
const docRefs = [...portItem.matchAll(/`([^`]+?\.(?:mjs|ts|tsx|html|rs|ps1|sh|md|json|py|xlsx))(?::([\d,\-]+))?`/g)]
  .map((m) => ({ file: m[1], spec: m[2] }))
  // A leading dot means the token is not a repo file path -- e.g. the audit
  // scope in the same paragraph is written as `.mjs/.js/.ts/...`, which would
  // otherwise be parsed as one bogus "file".
  .filter((r) => !r.file.startsWith('.'));
const docSet = new Set(docRefs.map((r) => r.file));
/** `file:line` positions the document claims (a spec may list several lines). */
const docPositions = new Set();
for (const r of docRefs) {
  if (!r.spec) continue;
  for (const part of r.spec.split(',')) {
    const [from, to] = part.split('-');
    const start = Number(from);
    if (!Number.isFinite(start)) continue;
    const end = Number(to ?? from);
    for (let n = start; n <= end; n++) docPositions.add(`${r.file}:${n}`);
  }
}

console.log('--- files listed in 16 §3.1 (port list) ---');
for (const f of [...docSet].sort()) console.log(`  ${f}`);
console.log('');

const missing = files.filter((f) => !docSet.has(f));
// The audit tool names itself in the doc; it is not a port-hardcoding site.
const SELF = 'tools/ats101-probes/scenario-d-port-audit.mjs';
/** Every file the probe classified, regardless of bucket. */
const allClassified = new Set([
  ...files,
  ...nonRuntimeFiles,
  ...docMentionFindings.map((f) => f.rel),
]);
const extra = [...docSet].filter(
  (f) => !allClassified.has(f) && f !== SELF,
);
const missingNonRuntime = nonRuntimeFiles.filter((f) => !docSet.has(f));

/**
 * Position check: every runtime occurrence must appear in the document as a
 * `file:line` reference. The baseline counts POSITIONS (6), not files (5),
 * because server/index.mjs holds two of them.
 */
const missingPositions = findings
  .map((f) => `${f.rel}:${f.line}`)
  .filter((pos) => !docPositions.has(pos));

console.log('--- verdict ---');
console.log(`runtime occurrences in source   : ${findings.length}`);
console.log(`distinct runtime files          : ${files.length}`);
console.log(`non-runtime data files          : ${nonRuntimeFiles.length}`);
console.log(`doc-mention files (excl. 16)    : ${docMentionFiles.length}`);
console.log(`doc mentions (excl. 16)         : ${docMentionOccurrences}`);
console.log(`runtime files missing from §3.1 : ${missing.length ? missing.join(', ') : '(none)'}`);
console.log(`non-runtime missing from §3.1   : ${missingNonRuntime.length ? missingNonRuntime.join(', ') : '(none)'}`);
console.log(`runtime positions missing       : ${missingPositions.length ? missingPositions.join(', ') : '(none)'}`);
console.log(`listed but not found at runtime : ${extra.length ? extra.join(', ') : '(none)'}`);

const countMatch = /硬编码在\s*(\S+?)\s*处/.exec(section)?.[1] ?? '(not stated)';
console.log(`count claimed in 16 §3.1        : ${countMatch}`);
console.log(`actual runtime occurrence count : ${findings.length}`);
const countOk = countMatch === String(findings.length);
console.log(`count matches source            : ${countOk}`);

/**
 * The doc-mention count stated in §3.1's audit-scope paragraph. It is stated
 * as "<N> 个文件共 <M> 处提及" -- so both numbers are checked.
 */
const docClaim = /(\d+)\s*个文件共\s*(\d+)\s*处提及/.exec(section);
const docClaimFiles = docClaim?.[1];
const docClaimMentions = docClaim?.[2];
const docCountOk = docClaimFiles === String(docMentionFiles.length)
  && docClaimMentions === String(docMentionOccurrences);
console.log(`doc files/mentions claimed      : ${docClaimFiles ?? '(not stated)'} / ${docClaimMentions ?? '(not stated)'}`);
console.log(`doc files/mentions actual       : ${docMentionFiles.length} / ${docMentionOccurrences}`);
console.log(`doc mention count matches       : ${docCountOk}`);

if (missing.length || extra.length || missingNonRuntime.length || missingPositions.length
  || !countOk || !docCountOk) {
  console.log('');
  console.log('RESULT: MISMATCH -- the port list in 16 §3.1 does not match the source.');
  process.exitCode = 1;
} else {
  console.log('');
  console.log('RESULT: OK -- every hardcoded occurrence is listed in 16 §3.1, by position.');
}
