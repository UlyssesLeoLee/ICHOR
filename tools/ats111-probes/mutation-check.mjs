#!/usr/bin/env node
/**
 * ATS-111 -- the MUTATION probe.
 *
 *   node tools/ats111-probes/mutation-check.mjs <repo> <scratch-dir> <playwright-node_modules>
 *
 * WHY THIS EXISTS
 * ---------------
 * A test suite that cannot fail is not evidence. This probe breaks the
 * delivered code in N ways and asserts that the test suite GOES RED for
 * each of them. A mutation that no test catches is a hole in the suite,
 * and the probe reports it as a FAIL.
 *
 * THE MUTATIONS
 * -------------
 * Each mutation is a SMALL, REAL change to the model or to the view --
 * the kind of change a careless edit would make. The probe copies the
 * tree, applies the mutation, runs the tests, and asserts that they
 * fail.
 *
 *  M1  the CANCELLED state is folded into the ERROR state -- the
 *      cancellation is reported as a failure;
 *  M2  the EMPTY state is folded into the CANCELLED state -- an empty
 *      list is reported as a cancellation;
 *  M3  the LOADING state is folded into the EMPTY state -- a load in
 *      flight is reported as "there is nothing here";
 *  M4  the ERROR state is folded into the EMPTY state -- a failure is
 *      reported as "there is nothing here";
 *  M5  the label of one state is made equal to the label of another --
 *      the states are no longer tellable apart by their words;
 *  M6  the Escape binding is removed -- the cancel command is gone;
 *  M7  the Enter binding is removed -- the submit command is gone;
 *  M8  `isTextEntry` always answers false -- the workbench hijacks the
 *      Enter key inside a text field;
 *  M9  an unknown outcome is swallowed (reported as "nothing to
 *      announce") instead of being reported as a failure;
 *  M10 the focus order is reversed -- the keyboard order is no longer
 *      the reading order.
 *
 * M1-M5 and M9 are caught by the UNIT tests; M6-M8 and M10 are caught
 * by the unit tests too (the model is where the bindings live), and
 * the ST probe catches the ones that only show up in a browser.
 *
 * Prints `PASS`/`FAIL` per mutation and `RESULT: <passed>/<total>`;
 * exits 0 only when every mutation was caught.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [repoArg, scratchArg] = process.argv.slice(2);
if (!repoArg || !scratchArg) {
  console.error('usage: mutation-check.mjs <repo> <scratch-dir>');
  process.exit(2);
}
const repo = path.resolve(repoArg);
fs.mkdirSync(scratchArg, { recursive: true });
const scratch = fs.mkdtempSync(path.join(path.resolve(scratchArg), 'mut111-'));

let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

const MODEL = 'apps/studio/lib/workbench-state.mjs';
const UNIT = 'tests/workbench-state.test.mjs';

/**
 * The mutations. Each is a pair of (find, replace) on the MODEL file.
 * The strings are distinctive enough that a mutation that does not
 * apply is DETECTED (the file is compared before and after), so a
 * mutation that silently did nothing cannot be counted as "caught".
 */
const MUTATIONS = [
  {
    id: 'M1 the cancelled state is folded into the error state',
    file: MODEL,
    find: "if (r.phase === 'cancelled') return 'cancelled';",
    replace: "if (r.phase === 'cancelled') return 'error';",
  },
  {
    id: 'M2 the empty state is folded into the cancelled state',
    file: MODEL,
    find: "if (r.phase === 'settled') return (r.itemCount > 0) ? null : 'empty';",
    replace: "if (r.phase === 'settled') return (r.itemCount > 0) ? null : 'cancelled';",
  },
  {
    id: 'M3 the loading state is folded into the empty state',
    file: MODEL,
    find: "if (r.phase === 'pending') return 'loading';",
    replace: "if (r.phase === 'pending') return 'empty';",
  },
  {
    id: 'M4 the error state is folded into the empty state',
    file: MODEL,
    find: "if (r.phase === 'failed') return 'error';",
    replace: "if (r.phase === 'failed') return 'empty';",
  },
  {
    id: 'M5 two states share one label',
    file: MODEL,
    find: "label: '已取消',",
    replace: "label: '加载失败',",
  },
  {
    id: 'M6 the Escape binding is removed',
    file: MODEL,
    find: "    key: 'Escape',\n    id: 'cancel',",
    replace: "    key: 'Escape',\n    id: 'cancel-disabled',",
  },
  {
    id: 'M7 the Enter binding is removed',
    file: MODEL,
    find: "    key: 'Enter',\n    id: 'submit',",
    replace: "    key: 'Enter',\n    id: 'submit-disabled',",
  },
  {
    id: 'M8 the text-entry guard always answers false',
    file: MODEL,
    find: "export function isTextEntry(target) {",
    replace: "export function isTextEntry(target) {\n  return false;",
  },
  {
    id: 'M9 an unknown outcome is swallowed instead of reported',
    file: MODEL,
    find: "  // difference would read \"no news\" as \"all is well\".\n  return 'error';\n}",
    replace: "  // difference would read \"no news\" as \"all is well\".\n  return null;\n}",
  },
  {
    id: 'M10 the focus order is reversed',
    file: MODEL,
    find: "export const FOCUS_ORDER = Object.freeze([\n  'rail',\n  'refresh',\n  'project-select',\n  'add-project',\n  'search',\n  'panel',\n  'content',\n]);",
    replace: "export const FOCUS_ORDER = Object.freeze([\n  'content',\n  'panel',\n  'search',\n  'add-project',\n  'project-select',\n  'refresh',\n  'rail',\n]);",
  },
];

/**
 * Run the unit tests against a tree and report whether they FAILED.
 *
 * The exit code is the conclusion: a mutation that leaves the suite
 * green is a hole.
 */
function runUnitTests(tree) {
  const r = spawnSync(process.execPath, ['--test', UNIT], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1536' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const failed = /^# fail (\d+)$/m.exec(out);
  const failCount = failed ? Number(failed[1]) : (/not ok/.test(out) ? 1 : 0);
  return { code: r.status, failCount, out };
}

/**
 * Copy the tree the mutation runs against.
 *
 * Only the files the tests and the model need are copied: the whole
 * repository is large, and the unit tests import nothing but the
 * model.
 */
function makeTree() {
  const tree = path.join(scratch, `tree-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(tree, 'apps', 'studio', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'tests'), { recursive: true });
  fs.copyFileSync(path.join(repo, MODEL), path.join(tree, MODEL));
  fs.copyFileSync(path.join(repo, UNIT), path.join(tree, UNIT));
  return tree;
}

for (const mutation of MUTATIONS) {
  const tree = makeTree();
  const target = path.join(tree, mutation.file);
  // The source is normalised to LF for the match: the checkout is CRLF
  // on Windows (core.autocrlf=true) and LF elsewhere, and a mutation
  // that is written with the other line ending would silently not
  // apply -- which the probe must report as a broken probe, never as a
  // result.
  const before = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  if (!before.includes(mutation.find)) {
    check(mutation.id, false, 'the mutation did not apply -- the probe is broken');
    continue;
  }
  const after = before.replace(mutation.find, mutation.replace);
  if (after === before) {
    check(mutation.id, false, 'the mutation did not change the file');
    continue;
  }
  fs.writeFileSync(target, after, 'utf8');

  const result = runUnitTests(tree);
  // The mutation must make the suite RED. A green suite means no test
  // covers this behaviour -- a hole in the suite, reported as FAIL.
  const caught = result.code !== 0 || result.failCount > 0;
  check(
    mutation.id,
    caught,
    caught
      ? `caught (${result.failCount} failing test(s))`
      : 'the suite stayed GREEN -- no test covers this behaviour',
  );
}

console.log('');
console.log(`scratch: ${scratch}`);
console.log(`RESULT: ${passed}/${total}`);
process.exitCode = passed === total ? 0 : 1;
