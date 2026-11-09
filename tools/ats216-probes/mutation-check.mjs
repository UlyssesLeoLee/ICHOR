#!/usr/bin/env node
/**
 * ATS-216 mutation check: the quality module's tests must FAIL when the
 * module is broken.
 *
 *   node tools/ats216-probes/mutation-check.mjs <repo> <scratch-dir> <playwright-node_modules>
 *
 * WHY THIS EXISTS
 * ---------------
 * A test suite that passes proves nothing unless a WRONG implementation makes
 * it red. This script MUTATES the module in the ways that matter for this
 * task's acceptance criterion -- each mutation is one of the confusions the
 * criterion forbids -- and asserts that the suite catches it.
 *
 * The mutations are exactly the ones the acceptance criterion is about:
 *
 *   1. the cancelled run counts as a FAILURE      (混淆取消与失败)
 *   2. the flaky case counts as a plain PASS       (混淆重试与通过)
 *   3. the reconciliation is always consistent     (指标不再可核对)
 *   4. the failure signature is constant           (聚类没有意义)
 *   5. the retry count is dropped                  (重试不被计数)
 *   6. the ANSI colour codes are kept              (同一个缺陷聚成两类)
 *   7. the attempt count ignores the attempts      (执行次数被抹掉)
 *   8. the cases of a run without a verdict enter the metrics
 *                                            (取消的运行污染了判定指标)
 *   9. the case identity is reduced to the file and the title
 *                                            (同名的两个用例被合并成一个)
 *  10. the case identity contains the LINE
 *                                            (用例上方的改动把它的历史切成两段)
 *  11. the displayed counts are not reconciled with the bridge
 *                                            (界面显示的数不再被核对)
 *
 * The module is restored after every mutation, and the script asserts that
 * the restored file is byte-identical to the original.
 *
 * Prints `PASS`/`FAIL` per mutation and `RESULT: <killed>/<total>`; exits 0
 * only when EVERY mutation was killed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [repoArg, scratchArg, nodeModulesArg] = process.argv.slice(2);
if (!repoArg || !scratchArg || !nodeModulesArg) {
  console.error('usage: mutation-check.mjs <repo> <scratch-dir> <playwright-node_modules>');
  process.exit(2);
}
const repo = path.resolve(repoArg);
const modulePath = path.join(repo, 'apps', 'studio', 'public', 'quality.mjs');
const original = fs.readFileSync(modulePath);

let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

/**
 * Each mutation is a (needle, replacement) pair. The needle must occur
 * EXACTLY ONCE in the module: a needle that occurs more than once would make
 * the mutation ambiguous, and the script says so instead of mutating
 * something it did not mean to.
 */
const MUTATIONS = [
  {
    id: 'the cancelled run counts as a failure',
    needle: "if (RUN_VERDICT_STATUSES.includes(s)) return 'verdict';",
    replacement: "if (RUN_VERDICT_STATUSES.includes(s) || s === 'cancelled') return 'verdict';",
  },
  {
    id: 'the flaky case counts as a plain pass',
    needle: "const s = String(status ?? '').toLowerCase();\n  return CASE_STATUSES.includes(s) ? s : CASE_STATUS.UNKNOWN;",
    replacement: "const s = String(status ?? '').toLowerCase();\n  return (s === 'flaky') ? CASE_STATUS.PASSED : (CASE_STATUSES.includes(s) ? s : CASE_STATUS.UNKNOWN);",
  },
  {
    id: 'the reconciliation is always consistent',
    needle: 'consistent: checks.every((c) => c.ok),',
    replacement: 'consistent: true,',
  },
  {
    id: 'the failure signature is constant',
    needle: 'const signature = normalizeErrorSignature(c.error);',
    replacement: "const signature = 'same';",
  },
  {
    id: 'the retry count is dropped',
    needle: 'const retryCount = Math.max(0, attemptsCount - 1);',
    replacement: 'const retryCount = 0;',
  },
  {
    id: 'the ANSI colour codes are kept',
    needle: "const plain = raw.replace(/\\u001b\\[[0-9;]*m/g, '');",
    replacement: 'const plain = raw;',
  },
  {
    id: 'the attempt count ignores the attempts',
    needle: 'const attemptsCount = Number.isFinite(c.attemptsCount)\n        ? c.attemptsCount\n        : attempts.length;',
    replacement: 'const attemptsCount = 1;',
  },
  {
    // The cases of a run that did not reach a verdict must not enter the
    // attempt buckets, the retry metrics or the cross-run view.
    id: 'the cases of a run without a verdict enter the metrics',
    needle: "      if (group !== 'verdict') {",
    replacement: "      if (false) {",
  },
  {
    // The cross-run identity must not merge two distinct cases.
    id: 'the case identity is reduced to the file and the title',
    needle: 'const tkey = testKeyOf(ref.file, ref.title, identity);',
    replacement: 'const tkey = testKeyOf(ref.file, ref.title);',
  },
  {
    // The identity must not contain the LINE: the line is the position of
    // the case in the file, and the position moves whenever anything above
    // the case changes. A key that carried it would split the history of
    // one case into two at every such edit.
    id: 'the case identity contains the line',
    needle: "  if (scope.length || line !== null) {\n    return JSON.stringify([String(file ?? ''), scope, String(title ?? '')]);",
    replacement: "  if (scope.length || line !== null) {\n    return JSON.stringify([String(file ?? ''), scope, line, String(title ?? '')]);",
  },
  {
    // The reconciliation must compare the DISPLAYED numbers with the
    // counters the bridge reported. The mutation removes the check, so a
    // module that buckets a case wrongly is no longer caught.
    id: 'the displayed counts are not reconciled with the bridge',
    needle: "if (!reportedBucketSeen[b]) continue;",
    replacement: "if (true) continue;",
  },
];

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, {
  cwd: repo, encoding: 'utf8', timeout: 600000, ...opts,
});

/*
 * LINE ENDINGS.
 *
 * The needle of a mutation spans several lines, so it has to match the
 * file's line endings: a checkout on Windows has CRLF and a checkout on
 * Linux has LF. The module is therefore matched and mutated in its
 * NORMALIZED form (LF), and the ORIGINAL BYTES are restored afterwards --
 * the restore is byte-for-byte, so the line endings of the tree are never
 * changed by the probe.
 */
const normalize = (s) => s.replace(/\r\n/g, '\n');

console.log('=== ATS-216 mutation check: the tests must fail when the module is broken ===');
console.log(`repo    : ${repo}`);
console.log(`module  : ${modulePath}`);
console.log('');

for (const m of MUTATIONS) {
  const text = normalize(original.toString('utf8'));
  const needle = normalize(m.needle);
  const replacement = normalize(m.replacement);
  const occurrences = text.split(needle).length - 1;
  if (occurrences !== 1) {
    check(`${m.id} -- the mutation is unambiguous`, false,
      `the needle occurs ${occurrences} time(s), expected exactly 1`);
    continue;
  }
  fs.writeFileSync(modulePath, text.replace(needle, replacement));

  const ut = run('node', ['--test', 'tests/quality-overview.test.mjs']);
  const st = run('node', ['tools/ats216-probes/st-ats216.mjs', '.', scratchArg, nodeModulesArg]);
  const utKilled = ut.status !== 0;
  const stKilled = st.status !== 0;
  const killed = utKilled || stKilled;
  check(`${m.id} -- killed`, killed,
    `UT ${utKilled ? 'KILL' : 'survive'} / ST ${stKilled ? 'KILL' : 'survive'}`);
  if (!killed) {
    const utTail = (ut.stdout || '').split('\n').filter((l) => l.startsWith('ℹ fail'));
    const stTail = (st.stdout || '').split('\n').filter((l) => l.startsWith('RESULT'));
    console.log(`      UT: ${utTail.join(' ') || 'no summary'}  ST: ${stTail.join(' ') || 'no summary'}`);
  }

  // The module is restored before the next mutation.
  fs.writeFileSync(modulePath, original);
}

const restored = fs.readFileSync(modulePath);
check('the module is restored byte-for-byte', restored.equals(original),
  `${restored.length} vs ${original.length} bytes`);

console.log('');
console.log(`RESULT: ${passed}/${total}`);
process.exitCode = passed === total ? 0 : 1;
