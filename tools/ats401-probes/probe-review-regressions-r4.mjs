#!/usr/bin/env node
/**
 * ATS-401 probe -- the round-4 counterexamples (review comment
 * 01a1ab68-7b95-7d65-b2d5-fc77500a621e).
 *
 * The round-3 review left ONE thing unresolved: the validator's path
 * parsing did not agree with git's, byte for byte. The validator used to
 * strip EVERY CR from the diff and then trim() the path, while git:
 *
 *   - truncates a path at a CR (the CR of a CRLF line ending excepted), and
 *   - KEEPS the whitespace at the END of a path.
 *
 * So `b/tests/new\r.spec.ts` is `tests/new` to git, and
 * `b/tests/new.spec.ts ` is `tests/new.spec.ts ` (trailing space) to git --
 * while the validator saw an in-scope `tests/new.spec.ts`. The proposal was
 * accepted while git wrote a DIFFERENT file.
 *
 * This probe pins that down on both sides:
 *
 *   FORWARD  -- for each of the review's counterexamples: the validator must
 *               REJECT it, and git must indeed disagree about the path.
 *   BACKWARD -- a real `git diff` must still be ACCEPTED, including one
 *               written with CRLF line endings (the one CR that IS allowed
 *               is the one at the end of the line).
 *
 * Usage: node tools/ats401-probes/probe-review-regressions-r4.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

console.log('=== ATS-401 probe: the round-4 counterexamples ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log(`work root : ${WORK_ROOT}`);
console.log('');

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
const SPEC = 'test("a", () => {});\n\n';
const request = validateAgentRequest({
  role: 'generator',
  scope: {
    projectId: 'probe_round4',
    root: gitRepo,
    files: ['tests/login.spec.ts'],
    outputs: ['tests/login.spec.ts', 'tests/new.spec.ts'],
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
const PRODUCER = { producedBy: 'probe-r4' };

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* The review's counterexamples.                                        */
/* ------------------------------------------------------------------ */
//
// Each entry carries the REASON it is rejected, because the reasons differ:
//
//   'git-divergence' -- git resolves the header to a DIFFERENT path than
//       the validator would see. That is the dangerous case: the proposal
//       looked in-scope while git wrote some other file.
//
//   'strict-rule' -- git happens to resolve it the same way, but the header
//       still violates this module's rule ("no whitespace at either end of
//       a path"). Rejecting it keeps the rule simple and total; it is the
//       conservative direction.
const COUNTEREXAMPLES = [
  ['CR inside a new-file path (b/tests/new\\r.spec.ts)', 'git-divergence',
    '--- /dev/null\n+++ b/tests/new\r.spec.ts\n@@ -0,0 +1 @@\n+test("n", () => {});\n'],
  ['CR inside a modified path (tests/login\\r.spec.ts)', 'git-divergence',
    '--- a/tests/login\r.spec.ts\n+++ b/tests/login\r.spec.ts\n@@ -1,2 +1,2 @@\n-test("a", () => {});\n+test("b", () => {});\n \n'],
  ['trailing space after a new-file path', 'git-divergence',
    '--- /dev/null\n+++ b/tests/new.spec.ts \n@@ -0,0 +1 @@\n+test("n", () => {});\n'],
  ['form feed after a new-file path', 'git-divergence',
    '--- /dev/null\n+++ b/tests/new.spec.ts\f\n@@ -0,0 +1 @@\n+test("n", () => {});\n'],
  ['two spaces before a new-file path', 'strict-rule',
    '--- /dev/null\n+++  b/tests/new.spec.ts\n@@ -0,0 +1 @@\n+test("n", () => {});\n'],
  ['vertical tab inside a new-file path', 'git-divergence',
    '--- /dev/null\n+++ b/tests/new\v.spec.ts\n@@ -0,0 +1 @@\n+test("n", () => {});\n'],
];

/* ------------------------------------------------------------------ */
console.log('--- A. the review\'s counterexamples are rejected ---');
for (const [label, reason, diff] of COUNTEREXAMPLES) {
  const code = codeOf(() => validateAgentProposal(
    { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
  ));
  check(`the validator rejects ${label}`, code === 'AGENT_PROPOSAL_OUT_OF_SCOPE', `code=${code} reason=${reason}`);
}

console.log('');
console.log('--- B. git really does disagree about the path ---');
// For the 'git-divergence' cases, git must NOT see the in-scope path
// `tests/new.spec.ts`. If git saw it, rejecting the diff would have been
// pointless -- the whole point is that git writes some OTHER file.
//
// The 'strict-rule' case (two spaces after `+++`) is different: git SKIPS
// the leading whitespace, so git and the validator would agree on the path.
// It is rejected anyway, because the header violates this module's rule
// ("no whitespace at either end of a path"). That is the conservative
// direction, and it is asserted here so the difference between the two
// reasons stays visible.
for (const [label, reason, diff] of COUNTEREXAMPLES) {
  const view = gitApplyView(diff);
  const seesInScope = view.paths.some((p) => p === 'tests/new.spec.ts' || p === 'tests/login.spec.ts');
  if (reason === 'git-divergence') {
    check(`git does not resolve ${label} to the in-scope path`,
      !seesInScope,
      `git paths=${JSON.stringify(view.paths)} summary=${view.summary || '(none)'}`);
  } else {
    check(`git resolves ${label} the same way -- rejected by the strict rule, not by divergence`,
      seesInScope,
      `git paths=${JSON.stringify(view.paths)} summary=${view.summary || '(none)'}`);
  }
}

console.log('');
console.log('--- C. the deletion-shaped diffs follow the measured git behaviour ---');
{
  // A traditional diff (no `diff --git` header) whose new side has no line
  // left is a DELETE as far as git is concerned.
  const removesEverything = '--- a/tests/login.spec.ts\n+++ b/tests/login.spec.ts\n@@ -1,2 +0,0 @@\n-test("a", () => {});\n-\n';
  const code = codeOf(() => validateAgentProposal(
    { summary: 'x', diff: removesEverything, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
  ));
  check('the validator rejects a traditional diff that removes every line',
    code === 'AGENT_PROPOSAL_OUT_OF_SCOPE', `code=${code}`);

  const view = gitApplyView(removesEverything);
  check('git really does report a delete for that traditional diff',
    view.ok && /\bdelete \S/i.test(view.summary),
    `summary=${view.summary || '(none)'}`);

  // The same diff WITH a `diff --git` header is NOT a delete for git.
  const withGitHeader = 'diff --git a/tests/login.spec.ts b/tests/login.spec.ts\n--- a/tests/login.spec.ts\n+++ b/tests/login.spec.ts\n@@ -1,2 +0,0 @@\n-test("a", () => {});\n-\n';
  const view2 = gitApplyView(withGitHeader);
  check('git does NOT report a delete for the same diff with a git header',
    view2.ok && !/\bdelete \S/i.test(view2.summary),
    `summary=${view2.summary || '(none)'}`);
  const code2 = codeOf(() => validateAgentProposal(
    { summary: 'x', diff: withGitHeader, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
  ));
  check('the validator accepts the same diff with a git header', code2 === null, `code=${code2}`);

  // A traditional diff that leaves lines behind is an ordinary modification.
  const removesSome = '--- a/tests/login.spec.ts\n+++ b/tests/login.spec.ts\n@@ -1,1 +1,1 @@\n-test("a", () => {});\n+test("b", () => {});\n';
  const code3 = codeOf(() => validateAgentProposal(
    { summary: 'x', diff: removesSome, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
  ));
  check('the validator accepts a traditional diff that removes only some lines',
    code3 === null, `code=${code3}`);
}

console.log('');
console.log('--- D. the CRLF line ending is still accepted ---');
// The one CR that IS allowed is the one at the END of a line: that is the
// CRLF line ending, not part of the path. A diff written with CRLF endings
// must keep working.
{
  const crlf = [
    '--- a/tests/login.spec.ts\r',
    '+++ b/tests/login.spec.ts\r',
    '@@ -1 +1 @@\r',
    "-test('login passes', async ({page}) => {});\r",
    "+test('login passes', async ({page}) => { await page.goto('/'); });\r",
  ].join('\n');
  const code = codeOf(() => validateAgentProposal(
    { summary: 'x', diff: crlf, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
  ));
  check('the validator accepts a diff whose header lines end with CRLF',
    code === null, `code=${code}`);
}

console.log('');
console.log('--- E. real git diff output is still accepted ---');
{
  // Collect real `git diff` output from git itself, the way the round-3
  // probe did, so this probe cannot drift away from git.
  const snap = (label, mutate) => {
    git(['reset', '-q', '--hard']);
    git(['clean', '-qfd']);
    mutate();
    git(['add', '-A']);
    const diff = git(['diff', '--cached', '--no-color']).stdout;
    git(['reset', '-q', '--hard']);
    git(['clean', '-qfd']);
    const code = codeOf(() => validateAgentProposal(
      { summary: 'x', diff, evidenceRefs: ['tests/login.spec.ts'] }, request, PRODUCER,
    ));
    check(`the validator accepts ${label}`, code === null, `code=${code}`);
  };
  snap('a real git diff: blank context line',
    () => fs.writeFileSync(path.join(gitRepo, 'tests/login.spec.ts'), 'test("b", () => {});\n\n'));
  snap('a real git diff: no final newline',
    () => fs.writeFileSync(path.join(gitRepo, 'tests/login.spec.ts'), 'test("a", () => {});\n\nexpect(1)'));
  snap('a real git diff: new spec file',
    () => fs.writeFileSync(path.join(gitRepo, 'tests/new.spec.ts'), 'test("n", () => {});\n'));
  snap('a real git diff: CRLF content lines',
    () => fs.writeFileSync(path.join(gitRepo, 'tests/login.spec.ts'), 'test("a", () => {});\r\n\r\n'));
}

console.log('');
console.log('--- verdict ---');
if (failures.length) {
  console.log(`FAIL: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('PASS: every round-4 counterexample is rejected, and real git diff output is still accepted');
}
