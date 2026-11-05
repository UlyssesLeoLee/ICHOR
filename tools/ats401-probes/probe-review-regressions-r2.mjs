#!/usr/bin/env node
/**
 * ATS-401 probe -- the regressions found by the 2nd review round.
 *
 * The 1st-round probe (probe-review-regressions.mjs) encoded the findings of
 * the 1st REJECT. This one encodes the findings of the 2nd REJECT, which
 * showed that the diff-scope check was still a BLACKLIST and therefore still
 * bypassable, and that two other guarantees did not hold.
 *
 * The counterexamples, and what each one now expects:
 *
 *   A. the diff scope cannot be bypassed by git header forms the blacklist
 *      did not enumerate:
 *      - the legacy `rename old <path>` / `rename new <path>` headers, which
 *        `git apply` still honours but which the old scanner never saw;
 *      - a C-quoted `diff --git "a/..." "b/..."` header, whose paths were
 *        dropped silently, so a segment with no ---/+++ lines could create a
 *        file outside the scope;
 *      - a C-quoted header plus a new empty file (no ---/+++ lines at all).
 *      -> all rejected with AGENT_PROPOSAL_OUT_OF_SCOPE
 *
 *   B. the deadline is enforced even when the process holds no other handle:
 *      -> a child process whose provider never settles gets
 *         AGENT_BUDGET_EXCEEDED and exits 0 (the old `unref()` let Node exit
 *         with code 13 before the deadline fired).
 *
 *   C. the WBS updater is idempotent:
 *      -> running it twice leaves row 60 byte-identical, and identical to the
 *         committed version (the old marker handling produced 【ATS-401】 twice).
 *
 *   D. the purity scanner flags the dynamic-code constructs:
 *      - `eval(...)`
 *      - `new Function(...)`
 *      -> both are reported as forbidden globals.
 *
 * Usage: node tools/ats401-probes/probe-review-regressions-r2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createAgentAdapter,
  createModelProvider,
  validateAgentProposal,
  validateAgentRequest,
} from '../../server/agent.mjs';
import { analyzeContractPurity } from './lib/contract-purity.mjs';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
const WORK_ROOT = path.resolve(
  process.env.ATS_PROBE_WORKDIR || path.join(process.env.TMPDIR || os.tmpdir(), 'ats401-review-regressions-r2'),
);

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const failures = [];
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

console.log('=== ATS-401 probe: 2nd-review-round regressions ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log(`work root : ${WORK_ROOT}`);
console.log('');

/* ------------------------------------------------------------------ */
console.log('--- A. the diff scope cannot be bypassed ---');

const fixture = path.join(WORK_ROOT, 'fixture-repo');
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
const SPEC = "test('login passes', async ({page}) => {});\n";
fs.writeFileSync(path.join(fixture, 'tests', 'login.spec.ts'), SPEC);

const LEGIT_HUNK = [
  'diff --git a/tests/login.spec.ts b/tests/login.spec.ts',
  '--- a/tests/login.spec.ts',
  '+++ b/tests/login.spec.ts',
  '@@ -1 +1 @@',
  "-test('login passes', async ({page}) => {});",
  "+test('login passes', async ({page}) => { await page.goto('/login'); });",
].join('\n');

const request = validateAgentRequest({
  role: 'generator',
  scope: {
    projectId: 'proj_review_r2',
    root: fixture,
    files: ['tests/login.spec.ts'],
    outputs: ['tests/login.spec.ts'],
    runs: [],
    requirements: [],
  },
  budget: { maxInputBytes: 100000, maxOutputBytes: 100000, maxSteps: 4, deadlineMs: 30000 },
  requestedCapabilities: ['propose_script_diff'],
  inputs: [{
    kind: 'file',
    ref: 'tests/login.spec.ts',
    digest: sha(SPEC),
    content: SPEC,
    retrievedAt: '2026-11-04T00:00:00.000Z',
  }],
});

// The platform supplies the producer; without it the proposal is rejected for
// a different reason (AGENT_PROPOSAL_INVALID), which would mask the diff
// verdict this probe is about.
const PRODUCER = { producedBy: 'gen-r2' };

const bypasses = [
  ['the legacy "rename old/new" headers',
    `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/tests/login.spec.ts\nrename old server/index.mjs\nrename new server/pwned.mjs\n`],
  ['a C-quoted diff --git header',
    `${LEGIT_HUNK}\ndiff --git "a/tests/login.spec.ts" "b/server/evil.mjs"\n--- a/tests/login.spec.ts\n+++ b/server/evil.mjs\n@@ -1 +1 @@\n-x\n+y\n`],
  ['a C-quoted diff --git header naming a new empty file',
    `${LEGIT_HUNK}\ndiff --git "a/tests/login.spec.ts" "b/server/evil.mjs"\nnew file mode 100644\n`],
  ['a context diff header (*** style)',
    `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/tests/login.spec.ts\n*** a/tests/login.spec.ts\n--- a/tests/login.spec.ts\n+++ b/tests/login.spec.ts\n@@ -1 +1 @@\n-x\n+y\n`],
  ['a similarity/dissimilarity index header',
    `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/tests/login.spec.ts\nsimilarity index 90%\n`],
  ['an Index: header',
    `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/tests/login.spec.ts\nIndex: tests/login.spec.ts\n`],
  ['a diff --git header whose two sides differ',
    `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/server/other.mjs\n--- a/tests/login.spec.ts\n+++ b/server/other.mjs\n@@ -1 +1 @@\n-x\n+y\n`],
  ['a hunk whose declared line count does not match its body',
    `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/tests/login.spec.ts\n--- a/tests/login.spec.ts\n+++ b/tests/login.spec.ts\n@@ -1,5 +1,5 @@\n-x\n+y\n`],
];
for (const [label, diff] of bypasses) {
  const code = codeOf(() => validateAgentProposal(
    { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] },
    request,
    PRODUCER,
  ));
  check(`${label} is rejected`, code === 'AGENT_PROPOSAL_OUT_OF_SCOPE', `code=${code}`);
}

// A legitimate diff must still be accepted -- the whitelist must not reject
// the ordinary case.
const legitCode = codeOf(() => validateAgentProposal(
  { summary: 'x', diff: LEGIT_HUNK, evidenceRefs: ['tests/login.spec.ts'] },
  request,
  PRODUCER,
));
check('a well-formed in-scope diff is still accepted', legitCode === null, `code=${legitCode}`);

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- B. the deadline holds without any other active handle ---');
const deadlineChild = path.join(WORK_ROOT, 'deadline-child.mjs');
fs.mkdirSync(WORK_ROOT, { recursive: true });
fs.writeFileSync(deadlineChild, `
import { pathToFileURL } from 'node:url';
const { createAgentAdapter, createModelProvider } =
  await import(pathToFileURL(${JSON.stringify(path.join(REPO_ROOT, 'server', 'agent.mjs'))}).href);

const provider = createModelProvider({ id: 'never', complete: () => new Promise(() => {}) });
const adapter = createAgentAdapter({
  adapterId: 'never',
  role: 'generator',
  capabilities: ['propose_script_diff'],
  provider,
});

try {
  await adapter.execute({
    role: 'generator',
    scope: {
      projectId: 'p',
      root: ${JSON.stringify(fixture)},
      files: ['tests/login.spec.ts'],
      outputs: ['tests/login.spec.ts'],
      runs: [],
      requirements: [],
    },
    budget: { maxInputBytes: 100000, maxOutputBytes: 100000, maxSteps: 4, deadlineMs: 1000 },
    requestedCapabilities: ['propose_script_diff'],
    inputs: [{
      kind: 'file',
      ref: 'tests/login.spec.ts',
      digest: ${JSON.stringify(sha(SPEC))},
      content: ${JSON.stringify(SPEC)},
      retrievedAt: '2026-11-04T00:00:00.000Z',
    }],
    egress: { kinds: ['file'] },
  });
  console.log('OUTCOME=settled');
  process.exitCode = 3;
} catch (error) {
  console.log('OUTCOME=' + error.code);
  process.exitCode = error.code === 'AGENT_BUDGET_EXCEEDED' ? 0 : 4;
}
`, 'utf8');

const child = spawnSync(process.execPath, [deadlineChild], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  timeout: 20000,
});
const outcome = (child.stdout || '').trim();
check('a hung provider is cut off at the deadline in a handle-free process',
  outcome === 'OUTCOME=AGENT_BUDGET_EXCEEDED' && child.status === 0,
  `outcome=${outcome} exit=${child.status} stderr=${String(child.stderr || '').trim().slice(0, 160)}`);

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- C. the WBS updater is idempotent ---');
// The updater rewrites docs/WBS.xlsx in place and takes no path argument, so
// the check runs against a scratch COPY of the repository: it must not touch
// the real workbook. The copy carries the same tools/ and docs/ layout.
const scratchRepo = path.join(WORK_ROOT, 'wbs-repo');
fs.rmSync(scratchRepo, { recursive: true, force: true });
fs.mkdirSync(path.join(scratchRepo, 'tools'), { recursive: true });
fs.mkdirSync(path.join(scratchRepo, 'docs'), { recursive: true });
for (const f of ['update_wbs_ats401.py', 'wbs_common.py']) {
  fs.copyFileSync(path.join(REPO_ROOT, 'tools', f), path.join(scratchRepo, 'tools', f));
}
fs.copyFileSync(path.join(REPO_ROOT, 'docs', 'WBS.xlsx'), path.join(scratchRepo, 'docs', 'WBS.xlsx'));

const pyScript = path.join(scratchRepo, 'tools', 'update_wbs_ats401.py');
const runUpdater = () => spawnSync('python', [pyScript], { cwd: scratchRepo, encoding: 'utf8' });
const scratchXlsx = path.join(scratchRepo, 'docs', 'WBS.xlsx');
const before = fs.readFileSync(scratchXlsx);

const run1 = runUpdater();
const after1 = fs.readFileSync(scratchXlsx);
const run2 = runUpdater();
const after2 = fs.readFileSync(scratchXlsx);

// marker count check via the cell inspector
const markerCount = (file) => {
  const py = spawnSync('python', ['-c', `
import re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    xml = z.read('xl/worksheets/sheet2.xml').decode('utf-8')
rid = None
for rm in re.finditer(r'<x:row[^>]*r="(\\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
    if '<x:v>ATS-401</x:v>' in rm.group(2):
        rid = int(rm.group(1)); break
m = re.search(r'<x:c r="T%d"[^>]*>(.*?)</x:c>' % rid, xml, re.S)
v = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S) if m else None
print((v.group(1) if v else '').count('【ATS-401】'))
`, file], { encoding: 'utf8' });
  return (py.stdout || '').trim();
};

check('the ATS-401 WBS updater runs', run1.status === 0 && run2.status === 0,
  `exit1=${run1.status} exit2=${run2.status} ${String(run1.stderr || '').slice(0, 160)}`);
check('the note keeps exactly one 【ATS-401】 marker after two runs',
  markerCount(scratchXlsx) === '1', `markers=${markerCount(scratchXlsx)}`);
check('running the updater twice leaves the file byte-identical',
  after1.equals(after2), `${after1.length}B vs ${after2.length}B`);
check('the updater is stable against the committed baseline',
  after2.equals(before), 'the second run differs from the committed workbook');
check("the repository's own workbook was not touched",
  fs.readFileSync(path.join(REPO_ROOT, 'docs', 'WBS.xlsx')).equals(before),
  'docs/WBS.xlsx changed on disk');

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- D. the purity scanner flags dynamic-code constructs ---');
const agentSource = fs.readFileSync(path.join(REPO_ROOT, 'server', 'agent.mjs'), 'utf8');
for (const [label, broken] of [
  ['eval(...)', `${agentSource}\nexport const w = (p) => eval('require("node:fs")');\n`],
  ['new Function(...)', `${agentSource}\nexport const f = () => new Function('return this')();\n`],
]) {
  const analysis = analyzeContractPurity(broken);
  check(`the detector flags ${label}`, !analysis.pure,
    `globals: ${analysis.forbiddenGlobals.join(', ') || 'none'}`);
}
check('the real contract layer is still pure', analyzeContractPurity(agentSource).pure, '');

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- verdict ---');
if (failures.length) {
  console.log(`FAIL: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('PASS: every 2nd-review-round regression is closed');
}
