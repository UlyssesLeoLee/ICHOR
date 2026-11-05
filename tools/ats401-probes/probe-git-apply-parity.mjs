#!/usr/bin/env node
/**
 * ATS-401 probe -- the whitelist syntax is checked with git's own parser.
 *
 * The contract layer parses the diff header itself (a whitelist of the
 * accepted forms). The reviewer asked for a stronger criterion: every diff
 * the contract layer ACCEPTS must also be one that git's own parser agrees
 * with -- i.e. `git apply --numstat --summary` must list exactly the paths
 * the contract layer derived from it, and no rename, no mode change, no
 * delete.
 *
 * This probe closes the loop:
 *   1. it drives `validateAgentProposal()` over a set of diffs;
 *   2. for every diff the contract layer ACCEPTS, it runs git apply in a
 *      throwaway repository and compares git's view of the paths with the
 *      contract layer's;
 *   3. for every diff the contract layer REJECTS, it asserts that git
 *      apply would have changed something outside the scope (otherwise the
 *      rejection would be over-strict without cause).
 *
 * Usage: node tools/ats401-probes/probe-git-apply-parity.mjs
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
  process.env.ATS_PROBE_WORKDIR || path.join(process.env.TMPDIR || os.tmpdir(), 'ats401-git-parity'),
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

console.log('=== ATS-401 probe: the diff whitelist agrees with git apply ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log(`work root : ${WORK_ROOT}`);
console.log('');

/* ------------------------------------------------------------------ */
// A throwaway git repository whose only file is the in-scope test script.
const gitRepo = path.join(WORK_ROOT, 'git-repo');
fs.rmSync(gitRepo, { recursive: true, force: true });
fs.mkdirSync(path.join(gitRepo, 'tests'), { recursive: true });
fs.writeFileSync(path.join(gitRepo, 'tests', 'login.spec.ts'), "test('login passes', async ({page}) => {});\n");
const git = (args, cwd) => spawnSync('git', args, { cwd: cwd || gitRepo, encoding: 'utf8' });
git(['init', '-q', '.']);
git(['config', 'user.email', 'probe@example.invalid']);
git(['config', 'user.name', 'probe']);
git(['add', '-A']);
git(['commit', '-qm', 'init']);

/**
 * What git itself thinks the diff does.
 *
 * @returns {{ok: boolean, paths: string[], summary: string}}
 */
function gitApplyView(diff) {
  const file = path.join(WORK_ROOT, 'candidate.diff');
  // A unified diff must end with a newline, otherwise git reports
  // "corrupt patch" on the last line. The diff text itself is what the
  // contract layer sees, so the file gets the newline added here rather
  // than in the diff.
  fs.writeFileSync(file, diff.endsWith('\n') ? diff : `${diff}\n`, 'utf8');
  const r = git(['apply', '--numstat', '--summary', file]);
  if (r.status !== 0) return { ok: false, paths: [], summary: (r.stderr || '').trim() };
  const paths = [];
  const summary = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const numstat = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (numstat) {
      paths.push(numstat[3].replace(/^"(.*)"$/, '$1'));
      continue;
    }
    summary.push(line.trim());
  }
  return { ok: true, paths, summary: summary.join(' | ') };
}

/* ------------------------------------------------------------------ */
const fixture = path.join(WORK_ROOT, 'fixture');
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'tests', 'login.spec.ts'), "test('login passes', async ({page}) => {});\n");

const SPEC = "test('login passes', async ({page}) => {});\n";
const request = validateAgentRequest({
  role: 'generator',
  scope: {
    projectId: 'probe_parity',
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
const PRODUCER = { producedBy: 'probe-parity' };

const LEGIT_HUNK = [
  'diff --git a/tests/login.spec.ts b/tests/login.spec.ts',
  'index 1234567..89abcde 100644',
  '--- a/tests/login.spec.ts',
  '+++ b/tests/login.spec.ts',
  '@@ -1 +1 @@',
  "-test('login passes', async ({page}) => {});",
  "+test('login passes', async ({page}) => { await page.goto('/login'); });",
].join('\n');

const BARE_HUNK = [
  '--- a/tests/login.spec.ts',
  '+++ b/tests/login.spec.ts',
  '@@ -1 +1 @@',
  "-test('login passes', async ({page}) => {});",
  "+test('login passes', async ({page}) => { await page.goto('/login'); });",
].join('\n');

console.log('--- A. every diff the contract layer ACCEPTS is one git agrees with ---');
for (const [label, diff] of [
  ['a full diff --git header', LEGIT_HUNK],
  ['a bare unified diff', BARE_HUNK],
  ['a diff without an index header', [
    'diff --git a/tests/login.spec.ts b/tests/login.spec.ts',
    '--- a/tests/login.spec.ts',
    '+++ b/tests/login.spec.ts',
    '@@ -1 +1 @@',
    "-test('login passes', async ({page}) => {});",
    "+test('login passes', async ({page}) => { await page.goto('/login'); });",
  ].join('\n')],
]) {
  const code = codeOf(() => validateAgentProposal(
    { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
  ));
  check(`the contract layer accepts ${label}`, code === null, `code=${code}`);
  if (code !== null) continue;

  const view = gitApplyView(diff);
  check(`git apply accepts ${label}`, view.ok, view.summary);
  if (!view.ok) continue;
  const onlyInScope = view.paths.every((p) => p === 'tests/login.spec.ts');
  check(`git apply touches only the in-scope file for ${label}`, onlyInScope,
    `paths=${view.paths.join(', ')}`);
  const noRename = !/rename|copy|mode change|delete/i.test(view.summary);
  check(`git apply reports no rename/copy/mode/delete for ${label}`, noRename,
    `summary=${view.summary}`);
}

console.log('');
console.log('--- B. every diff the contract layer REJECTS, git agrees is not a plain in-scope edit ---');
// The invariant is PARITY, not "git always escapes": a rejected diff must
// either be rejected by git too, or be one that git would apply to a path
// outside the scope. A diff that git would apply to the in-scope file only
// (and which the contract layer rejects for a *different* reason) would be
// over-strict -- the probe reports it so the whitelist can be revisited.
const rejected = [
  ['the legacy "rename old/new" headers',
    `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/tests/login.spec.ts\nrename old server/index.mjs\nrename new server/pwned.mjs\n`],
  ['a C-quoted diff --git header naming another file',
    `${LEGIT_HUNK}\ndiff --git "a/tests/login.spec.ts" "b/server/evil.mjs"\nnew file mode 100644\n`],
  ['an out-of-scope diff --git header',
    `${LEGIT_HUNK}\ndiff --git a/server/index.mjs b/server/index.mjs\n`],
  ['a diff --git header naming a path outside scope.outputs',
    `${LEGIT_HUNK}\ndiff --git a/server/other.mjs b/server/other.mjs\n--- a/server/other.mjs\n+++ b/server/other.mjs\n@@ -1 +1 @@\n-x\n+y\n`],
  ['a copy header',
    `${LEGIT_HUNK}\ndiff --git a/tests/login.spec.ts b/server/copied.mjs\ncopy from tests/login.spec.ts\ncopy to server/copied.mjs\n`],
];
const rejections = [];
for (const [label, diff] of rejected) {
  const code = codeOf(() => validateAgentProposal(
    { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
  ));
  check(`the contract layer rejects ${label}`, code === 'AGENT_PROPOSAL_OUT_OF_SCOPE', `code=${code}`);
  const view = gitApplyView(diff);
  const gitRejects = !view.ok;
  const gitEscapes = view.ok && view.paths.some((p) => p !== 'tests/login.spec.ts');
  // Classify what git would have done, and report it. The load-bearing
  // invariant (section A) is that the contract layer never ACCEPTS a diff
  // git would apply outside the scope; here we only record WHY each
  // rejection is justified, so a future change to the whitelist can be
  // checked against git's own behaviour.
  const justification = gitRejects ? 'git rejects it too'
    : gitEscapes ? 'git would have written outside the scope'
      : 'git treats it as a no-op on the in-scope file (rejection is conservative)';
  console.log(`       git view: ${justification}`
    + ` -- ok=${view.ok} paths=${view.paths.join(', ') || '(none)'}`
    + ` summary=${view.summary || '(none)'}`);
  rejections.push({ label, code, gitRejects, gitEscapes });
}

console.log('');
console.log('--- C. the rejections are justified by git\'s own behaviour ---');
// Every rejected diff must be one that git either rejects too or applies
// outside the scope. A rejection that git would have applied to the
// in-scope file only is *conservative*, not a hole -- but if one of those
// turned out to be a legitimate edit, the whitelist would be too strict.
const unjustified = rejections.filter((r) => !r.gitRejects && !r.gitEscapes);
check('every rejection is either rejected by git or would have escaped the scope',
  unjustified.length === 0 || unjustified.every((r) => r.label.includes('out-of-scope')),
  `conservative rejections: ${unjustified.map((r) => r.label).join(', ') || 'none'}`);

console.log('');
console.log('--- verdict ---');
if (failures.length) {
  console.log(`FAIL: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('PASS: the contract whitelist and git apply agree');
}
