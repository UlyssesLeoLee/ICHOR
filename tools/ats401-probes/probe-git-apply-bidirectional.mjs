#!/usr/bin/env node
/**
 * ATS-401 probe -- the diff whitelist is checked with git's OWN parser, in
 * BOTH directions.
 *
 * The round-3 review (comment 01a1a9f1-5f4d-7ad7-8faf-2be06893ac83) asked
 * for a *bidirectional* differential test instead of the one-directional
 * spot check that probe-git-apply-parity.mjs performs:
 *
 *   (i)  FORWARD -- the corpus contains the reviewer's three counterexamples
 *        plus automatic mutations of a legal diff (insert a blank line, drop
 *        the a/ b/ prefix, turn the target into /dev/null, append a
 *        `---`/`+++` section after the hunk, ...). For EVERY input the
 *        validator ACCEPTS, assert that git's numstat and summary name only
 *        paths inside scope.outputs, and that there is no create (outside
 *        outputs), no delete, no rename and no mode change.
 *
 *   (ii) BACKWARD -- real `git diff` output must be ACCEPTED, at least for
 *        the three shapes named by the review: a whitespace-only context
 *        line, a file with no trailing newline, and a newly created spec
 *        file.
 *
 * The verdict is deliberately scoped: it states agreement ON THIS CORPUS.
 * It does not claim that the whitelist is equivalent to git for every
 * possible diff.
 *
 * Usage: node tools/ats401-probes/probe-git-apply-bidirectional.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateAgentProposal, validateAgentRequest } from '../../server/agent.mjs';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
const WORK_ROOT = path.resolve(
  process.env.ATS_PROBE_WORKDIR
    || path.join(process.env.TMPDIR || os.tmpdir(), 'ats401-git-bidirectional'),
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

console.log('=== ATS-401 probe: the diff whitelist agrees with git apply, both ways ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log(`work root : ${WORK_ROOT}`);
console.log('');

/* ------------------------------------------------------------------ */
/* The scope the contract layer is checked against.                     */
/* ------------------------------------------------------------------ */
const SCOPE_OUTPUTS = ['tests/login.spec.ts', 'tests/new.spec.ts'];
const IN_SCOPE = new Set(SCOPE_OUTPUTS);

/* ------------------------------------------------------------------ */
/* A throwaway git repository that mirrors the scope.                   */
/* ------------------------------------------------------------------ */
const gitRepo = path.join(WORK_ROOT, 'git-repo');
fs.rmSync(gitRepo, { recursive: true, force: true });
fs.mkdirSync(path.join(gitRepo, 'tests'), { recursive: true });
fs.writeFileSync(
  path.join(gitRepo, 'tests', 'login.spec.ts'),
  'test("a", () => {});\n\n',
  'utf8',
);
const git = (args, cwd) => spawnSync('git', args, { cwd: cwd || gitRepo, encoding: 'utf8' });
git(['init', '-q', '.']);
git(['config', 'user.email', 'probe@example.invalid']);
git(['config', 'user.name', 'probe']);
git(['config', 'core.autocrlf', 'false']);
git(['add', '-A']);
git(['commit', '-qm', 'init']);

/**
 * What git itself thinks the diff does.
 *
 * @returns {{ok: boolean, paths: string[], summary: string, created: string[]}}
 */
function gitApplyView(diff) {
  const file = path.join(WORK_ROOT, 'candidate.diff');
  // A unified diff must end with a newline, otherwise git reports
  // "corrupt patch" on the last line. The diff text itself is what the
  // contract layer sees, so the newline is added here rather than in the
  // diff.
  fs.writeFileSync(file, diff.endsWith('\n') ? diff : `${diff}\n`, 'utf8');
  const r = git(['apply', '--numstat', '--summary', file]);
  if (r.status !== 0) {
    return { ok: false, paths: [], summary: (r.stderr || '').trim(), created: [] };
  }
  const paths = [];
  const summary = [];
  const created = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const numstat = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (numstat) {
      paths.push(numstat[3].replace(/^"(.*)"$/, '$1'));
      continue;
    }
    const create = /^create mode \d+ (.+)$/.exec(line.trim());
    if (create) {
      created.push(create[1]);
      summary.push(line.trim());
      continue;
    }
    summary.push(line.trim());
  }
  return { ok: true, paths, summary: summary.join(' | '), created };
}

/* ------------------------------------------------------------------ */
const fixture = path.join(WORK_ROOT, 'fixture');
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'tests', 'login.spec.ts'), 'test("a", () => {});\n\n', 'utf8');

const SPEC = 'test("a", () => {});\n\n';
const request = validateAgentRequest({
  role: 'generator',
  scope: {
    projectId: 'probe_bidirectional',
    root: fixture,
    files: ['tests/login.spec.ts'],
    outputs: SCOPE_OUTPUTS,
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
const PRODUCER = { producedBy: 'probe-bidirectional' };

/* ------------------------------------------------------------------ */
/* The corpus.                                                          */
/* ------------------------------------------------------------------ */

// The legal diff every mutation is derived from. It has a blank context
// line -- the shape the reviewer's counterexample relied on.
const LEGAL = [
  'diff --git a/tests/login.spec.ts b/tests/login.spec.ts',
  'index 8218917..56d39a6 100644',
  '--- a/tests/login.spec.ts',
  '+++ b/tests/login.spec.ts',
  '@@ -1,2 +1,3 @@',
  ' test("a", () => {});',
  ' ',
  '+test("b", () => {});',
].join('\n');

// The reviewer's three counterexamples, verbatim in spirit.
const REVIEWER_COUNTEREXAMPLES = [
  ['CE1a: a second file smuggled in after a blank line',
    'diff --git a/tests/login.spec.ts b/tests/login.spec.ts\n'
    + '--- a/tests/login.spec.ts\n+++ b/tests/login.spec.ts\n'
    + '@@ -1,2 +1,2 @@\n-test("a", () => {});\n+test("b", () => {});\n'
    + '\n'
    + '--- a/server/index.mjs\n+++ b/server/index.mjs\n'
    + '@@ -1 +1 @@\n-x\n+console.log("pwn")\n'],
  ['CE1b: an unprefixed path (git -p1 strips one component)',
    '--- /dev/null\n+++ tests/login.spec.ts\n@@ -0,0 +1 @@\n+test("planted", () => {});\n'],
  ['CE1c: a deletion via +++ /dev/null',
    '--- a/tests/login.spec.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-test("a", () => {});\n-\n'],
];

// Automatic mutations of the legal diff.
const MUTATIONS = [
  ['M1: insert a blank line into the hunk body',
    LEGAL.replace('@@ -1,2 +1,3 @@', '@@ -1,2 +1,3 @@\n')],
  ['M2: drop the a/ b/ prefixes',
    LEGAL.replace('--- a/tests/login.spec.ts', '--- tests/login.spec.ts')
      .replace('+++ b/tests/login.spec.ts', '+++ tests/login.spec.ts')],
  ['M3: turn the target into /dev/null (a deletion)',
    LEGAL.replace('+++ b/tests/login.spec.ts', '+++ /dev/null')],
  ['M4: append a ---/+++ section after the hunk',
    `${LEGAL}\n--- a/server/index.mjs\n+++ b/server/index.mjs\n@@ -1 +1 @@\n-x\n+y\n`],
  ['M5: overshoot the declared hunk counts',
    `${LEGAL}\n+extra\n`],
  ['M6: rename the file out of the scope',
    LEGAL.replace('b/tests/login.spec.ts', 'b/server/pwned.mjs')],
  ['M7: drop the index header',
    LEGAL.split('\n').filter((l) => !l.startsWith('index ')).join('\n')],
  ['M8: change the file mode',
    `${LEGAL}\ndiff --git a/tests/login.spec.ts b/tests/login.spec.ts\nold mode 100644\nnew mode 100755\n`],
];

// Real `git diff` output that must be ACCEPTED.
const REAL_GIT_DIFFS = [
  ['R1: a whitespace-only context line',
    'diff --git a/tests/login.spec.ts b/tests/login.spec.ts\n'
    + 'index 8218917..8236f46 100644\n'
    + '--- a/tests/login.spec.ts\n'
    + '+++ b/tests/login.spec.ts\n'
    + '@@ -1,2 +1,3 @@\n'
    + ' test("a", () => {});\n'
    + '-\n'
    + '+   \n'
    + '+test("b", () => {});\n'],
  ['R2: a file with no trailing newline',
    'diff --git a/tests/login.spec.ts b/tests/login.spec.ts\n'
    + 'index 8218917..aceefb7 100644\n'
    + '--- a/tests/login.spec.ts\n'
    + '+++ b/tests/login.spec.ts\n'
    + '@@ -1,2 +1 @@\n'
    + '-test("a", () => {});\n'
    + '-\n'
    + '+test("a", () => {});\n'
    + '\\ No newline at end of file\n'],
  ['R3: a newly created spec file',
    'diff --git a/tests/new.spec.ts b/tests/new.spec.ts\n'
    + 'new file mode 100644\n'
    + 'index 0000000..01eca86\n'
    + '--- /dev/null\n'
    + '+++ b/tests/new.spec.ts\n'
    + '@@ -0,0 +1 @@\n'
    + '+test("n", () => {});\n'],
];

/* ================================================================== */
console.log('--- A. FORWARD: everything the validator accepts, git agrees with ---');

const corpus = [
  ['the legal baseline diff', LEGAL],
  ...REVIEWER_COUNTEREXAMPLES,
  ...MUTATIONS,
  ...REAL_GIT_DIFFS,
];

let accepted = 0;
for (const [label, diff] of corpus) {
  const code = codeOf(() => validateAgentProposal(
    { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
  ));
  if (code !== null) {
    console.log(`  [ok  ] rejected: ${label} (${code})`);
    continue;
  }
  accepted += 1;
  const view = gitApplyView(diff);
  check(`git apply accepts what the validator accepted: ${label}`, view.ok,
    view.ok ? '' : view.summary);
  if (!view.ok) continue;

  const outOfScope = view.paths.filter((p) => !IN_SCOPE.has(p));
  check(`git names only in-scope paths: ${label}`, outOfScope.length === 0,
    `paths=${view.paths.join(', ') || '(none)'} out-of-scope=${outOfScope.join(', ') || 'none'}`);

  const createdOutOfScope = view.created.filter((p) => !IN_SCOPE.has(p));
  check(`git creates nothing outside the scope: ${label}`, createdOutOfScope.length === 0,
    `created=${view.created.join(', ') || 'none'}`);

  const noDelete = !/\bdelete mode\b/i.test(view.summary);
  check(`git reports no delete: ${label}`, noDelete, `summary=${view.summary || '(none)'}`);

  const noRename = !/\brename (from|to)\b/i.test(view.summary);
  check(`git reports no rename: ${label}`, noRename, `summary=${view.summary || '(none)'}`);

  const noModeChange = !/\bmode change\b/i.test(view.summary);
  check(`git reports no mode change: ${label}`, noModeChange, `summary=${view.summary || '(none)'}`);
}

console.log('');
console.log('--- B. the reviewer\'s counterexamples are all rejected ---');
for (const [label, diff] of REVIEWER_COUNTEREXAMPLES) {
  const code = codeOf(() => validateAgentProposal(
    { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
  ));
  check(`the validator rejects ${label}`, code === 'AGENT_PROPOSAL_OUT_OF_SCOPE', `code=${code}`);
}

console.log('');
console.log('--- C. BACKWARD: real git diff output is accepted ---');
for (const [label, diff] of REAL_GIT_DIFFS) {
  const code = codeOf(() => validateAgentProposal(
    { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
  ));
  check(`the validator accepts ${label}`, code === null, `code=${code}`);
}

console.log('');
console.log('--- D. the real git diff output is what git itself produces ---');
// The corpus entries above are hand-copied from `git diff`. Verify that
// git really produces that shape, so the corpus cannot drift away from git.
{
  const work = path.join(WORK_ROOT, 'verify-repo');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'tests'), { recursive: true });
  const g = (args) => spawnSync('git', args, { cwd: work, encoding: 'utf8' });
  g(['init', '-q', '.']);
  g(['config', 'user.email', 'probe@example.invalid']);
  g(['config', 'user.name', 'probe']);
  g(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(work, 'tests/login.spec.ts'), 'test("a", () => {});\n\n', 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);

  // R1 -- whitespace-only context line
  fs.writeFileSync(path.join(work, 'tests/login.spec.ts'), 'test("a", () => {});\n   \ntest("b", () => {});\n', 'utf8');
  const r1 = g(['diff', '--', 'tests/login.spec.ts']).stdout;
  check('git itself produces the whitespace-context diff shape', r1.includes('@@ -1,2 +1,3 @@'),
    r1.replace(/\n/g, ' | ').slice(0, 200));

  // R2 -- no trailing newline
  fs.writeFileSync(path.join(work, 'tests/login.spec.ts'), 'test("a", () => {});', 'utf8');
  const r2 = g(['diff', '--', 'tests/login.spec.ts']).stdout;
  check('git itself produces the no-trailing-newline diff shape',
    r2.includes('\\ No newline at end of file'),
    r2.replace(/\n/g, ' | ').slice(0, 200));

  // R3 -- a newly created file
  fs.writeFileSync(path.join(work, 'tests/new.spec.ts'), 'test("n", () => {});\n', 'utf8');
  g(['add', '-N', 'tests/new.spec.ts']);
  const r3 = g(['diff', '--', 'tests/new.spec.ts']).stdout;
  check('git itself produces the new-file diff shape',
    r3.includes('new file mode 100644') && r3.includes('--- /dev/null'),
    r3.replace(/\n/g, ' | ').slice(0, 200));
}

console.log('');
console.log('--- verdict ---');
if (failures.length) {
  console.log(`FAIL: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`PASS: on this corpus (${corpus.length} inputs, ${accepted} accepted), `
    + 'the contract whitelist and git apply agree in both directions');
}
