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
import { REPO_ROOT } from './lib/bridge.mjs';

const PORT = '4577';

console.log('=== ATS-101 scenario D: hardcoded default-port audit ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log(`port      : ${PORT}`);
console.log('');

/** Directories that are not part of the shipped source. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'out', 'dist', 'target', 'test-results', 'playwright-report', '.multica']);
const SOURCE_EXT = new Set(['.mjs', '.js', '.ts', '.tsx', '.html', '.rs', '.json', '.md', '.ps1', '.sh']);

/**
 * Files that mention the port but do not hardcode it at runtime.
 * They are listed in the baseline document as non-runtime references and are
 * checked separately, so the audit must not count them as runtime hardcoding.
 */
const NON_RUNTIME = new Set([
  'README.md',            // usage instructions
  'start.ps1',            // launcher script: prints / opens a URL
  'start.sh',             // launcher script: prints a URL
  'tests/test-cases.json', // test-case data (input strings)
]);

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
for (const file of walk(REPO_ROOT)) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  // Docs and evidence are excluded: they *mention* the port, they don't hardcode it.
  if (rel.startsWith('docs/')) continue;
  if (rel.startsWith('tools/ats101-probes/')) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.includes(PORT)) return;
    const entry = { rel, line: i + 1, text: line.trim() };
    if (NON_RUNTIME.has(rel)) nonRuntimeFindings.push(entry);
    else findings.push(entry);
  });
}

console.log('--- RUNTIME hardcoding in shipped source ---');
for (const f of findings) {
  console.log(`  ${f.rel}:${f.line}  ${f.text.length > 110 ? f.text.slice(0, 110) + '...' : f.text}`);
}
console.log(`total = ${findings.length}`);
console.log('');

console.log('--- NON-runtime mentions (documented separately) ---');
for (const f of nonRuntimeFindings) {
  console.log(`  ${f.rel}:${f.line}  ${f.text.length > 100 ? f.text.slice(0, 100) + '...' : f.text}`);
}
console.log(`total = ${nonRuntimeFindings.length}`);
console.log('');

const files = [...new Set(findings.map((f) => f.rel))].sort();
const nonRuntimeFiles = [...new Set(nonRuntimeFindings.map((f) => f.rel))].sort();
console.log('--- distinct RUNTIME files ---');
for (const f of files) console.log(`  ${f}`);
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
const docRefs = [...portItem.matchAll(/`([^`]+?\.(?:mjs|ts|tsx|html|rs|ps1|sh|md|json))(?::([\d,\-]+))?`/g)]
  .map((m) => ({ file: m[1], spec: m[2] }));
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
const extra = [...docSet].filter((f) => !files.includes(f) && !nonRuntimeFiles.includes(f) && f !== SELF);
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
console.log(`non-runtime files               : ${nonRuntimeFiles.length}`);
console.log(`runtime files missing from §3.1 : ${missing.length ? missing.join(', ') : '(none)'}`);
console.log(`non-runtime missing from §3.1   : ${missingNonRuntime.length ? missingNonRuntime.join(', ') : '(none)'}`);
console.log(`runtime positions missing       : ${missingPositions.length ? missingPositions.join(', ') : '(none)'}`);
console.log(`listed but not found at runtime : ${extra.length ? extra.join(', ') : '(none)'}`);

const countMatch = /硬编码在\s*(\S+?)\s*处/.exec(section)?.[1] ?? '(not stated)';
console.log(`count claimed in 16 §3.1        : ${countMatch}`);
console.log(`actual runtime occurrence count : ${findings.length}`);
const countOk = countMatch === String(findings.length);
console.log(`count matches source            : ${countOk}`);

if (missing.length || extra.length || missingNonRuntime.length || missingPositions.length || !countOk) {
  console.log('');
  console.log('RESULT: MISMATCH -- the port list in 16 §3.1 does not match the source.');
  process.exitCode = 1;
} else {
  console.log('');
  console.log('RESULT: OK -- every hardcoded occurrence is listed in 16 §3.1, by position.');
}
