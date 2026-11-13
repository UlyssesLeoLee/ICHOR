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
 * TWO KINDS OF MUTATION
 * ---------------------
 *
 *   MODEL mutations (M1-M17) break `apps/studio/lib/workbench-state.mjs`.
 *   They are caught by the UNIT tests, which import the model directly.
 *
 *   VIEW mutations (V1-V6) break `apps/studio/app/page.tsx` -- the WIRING
 *   between the model and the screen. The unit tests cannot see them: the
 *   model is still perfect while the screen says the wrong thing. So
 *   these are caught by the SYSTEM TEST, which drives the real static
 *   export in a real browser.
 *
 *   The view mutations are the ones that matter most: every defect the
 *   review found was in the wiring, not in the model.
 *
 * THE MODEL MUTATIONS
 * -------------------
 *   M1-M13   the four states, the key bindings and the guards.
 *   M14      the Escape target ignores the RUN -- the footer would
 *            promise a capability that does not exist. This is the
 *            defect the round-2 review found, reduced to the model.
 *   M15      the Escape target ignores the LOAD.
 *   M16      the Escape target prefers the LOAD over the DIALOG -- the
 *            nesting is inverted.
 *   M17      the Escape help stops naming the run.
 *
 * THE VIEW MUTATIONS
 * ------------------
 *   V1  the retry sets the project to the value it
 *       already has -- so React does not re-run the effect and NO
 *       request is issued. The 「重新加载」 button becomes a no-op.
 *   V2  the key handler intercepts Enter on ANY target and performs its
 *       own write -- so focusing 「取消」 and pressing Enter adds the
 *       project instead of cancelling it.
 *   V3  the catalogue is NOT cleared when the project changes -- so the
 *       previous project's cases stay on screen while the new project
 *       loads, and the metrics and the footer count them.
 *   V4  the key handler is bound to the app shell instead of the
 *       document -- so the commands do not work when the focus is on
 *       the <body>.
 *   V5  Escape does NOT stop the run -- the round-2 defect, restored.
 *       The footer promises it, so the system test must catch it.
 *   V6  Ctrl+P inside the dialog is NOT consumed -- the round-2
 *       regression, restored. The key leaks to the browser's own Print
 *       command.
 *
 * HOW THE VIEW MUTATIONS ARE RUN
 * -------------------------------
 * Each view mutation is applied to a COPY of the tree, the copy is
 * BUILT (Next.js static export), and the system test is run against the
 * built copy. A mutation that leaves the suite green is a hole.
 *
 * The build is what makes this expensive: Turbopack refuses to resolve
 * packages that live outside its workspace root, so `node_modules` is
 * COPIED into the mutated tree rather than linked. The copy is done once
 * and reused for every mutation, because the copy dominates the runtime.
 *
 * Prints `PASS`/`FAIL` per mutation and `RESULT: <passed>/<total>`;
 * exits 0 only when every mutation was caught.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [repoArg, scratchArg, nodeModulesArg] = process.argv.slice(2);
if (!repoArg || !scratchArg || !nodeModulesArg) {
  console.error('usage: mutation-check.mjs <repo> <scratch-dir> <playwright-node_modules>');
  process.exit(2);
}
const repo = path.resolve(repoArg);
const studioNodeModules = path.resolve(nodeModulesArg);
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
const VIEW = 'apps/studio/app/page.tsx';
const UNIT = 'tests/workbench-state.test.mjs';

/**
 * The MODEL mutations. Each is a pair of (find, replace) on the MODEL
 * file. The strings are distinctive enough that a mutation that does
 * not apply is DETECTED (the file is compared before and after), so a
 * mutation that silently did nothing cannot be counted as "caught".
 */
const MODEL_MUTATIONS = [
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
    find: "export const FOCUS_ORDER = Object.freeze([\n  'rail',\n  'refresh',\n  'project-select',\n  'add-project',\n  'search',\n  'sidebar',\n  'panel',\n  'content',\n]);",
    replace: "export const FOCUS_ORDER = Object.freeze([\n  'content',\n  'panel',\n  'sidebar',\n  'search',\n  'add-project',\n  'project-select',\n  'refresh',\n  'rail',\n]);",
  },
  {
    id: 'M11 the no-project state is folded into the request states',
    file: MODEL,
    find: "  if (!hasProject) return { ...NO_PROJECT_STATE };",
    replace: "  if (!hasProject) return workbenchState(request);",
  },
  {
    id: 'M12 the native-Enter guard always answers false',
    file: MODEL,
    find: "export function hasNativeEnterAction(target) {",
    replace: "export function hasNativeEnterAction(target) {\n  return false;",
  },
  {
    id: 'M13 an IME composition is treated as a command',
    file: MODEL,
    find: "  if (event.isComposing === true) return true;",
    replace: "  if (event.isComposing === true) return false;",
  },
  {
    id: 'M14 the Escape target ignores the RUN (the footer would promise a capability that does not exist)',
    file: MODEL,
    find: "  if (s.runActive === true) return 'run';",
    replace: "  if (s.runActive === true) return null;",
  },
  {
    id: 'M15 the Escape target ignores the LOAD',
    file: MODEL,
    find: "  if (s.loadPending === true) return 'load';",
    replace: "  if (s.loadPending === true) return null;",
  },
  {
    id: 'M16 the Escape target prefers the LOAD over the DIALOG (the nesting is inverted)',
    file: MODEL,
    find: "  if (s.dialogOpen === true) return 'dialog';\n  if (s.loadPending === true) return 'load';",
    replace: "  if (s.loadPending === true) return 'load';\n  if (s.dialogOpen === true) return 'dialog';",
  },
  {
    id: 'M17 the Escape help stops naming the run (a capability the workbench has, unpromised)',
    file: MODEL,
    find: "    description: '关闭弹窗，或取消正在进行的加载或运行',",
    replace: "    description: '关闭弹窗，或取消正在进行的加载',",
  },
];

/**
 * The VIEW mutations. Each breaks the WIRING in `page.tsx`.
 *
 * V1 -- the retry is a no-op: the project is set to the value it
 *       already has, so React does not re-run the effect.
 * V2 -- the Enter guard for a focused control is removed, so the
 *       workbench performs its own write instead of letting the control
 *       act.
 * V3 -- the catalogue is not cleared on a project change, so the
 *       previous project's cases stay on screen.
 * V4 -- the key handler is bound to the app shell instead of the
 *       document, so the commands do not work from the <body>.
 */
const VIEW_MUTATIONS = [
  {
    id: 'V1 the 「重新加载」 button issues no request (the retry is a no-op)',
    file: VIEW,
    find: "const reloadCatalogue=useCallback(()=>setReloadToken(n=>n+1),[]);",
    replace: "const reloadCatalogue=useCallback(()=>setActive(a=>a),[]);",
  },
  {
    id: 'V2 the Enter key swallows the focused control own action (the rejected behaviour, restored)',
    file: VIEW,
    find: "   // A text field keeps its own Enter behaviour.\n   if(isTextEntry(target))return;\n   // A control with its own Enter action keeps it: the browser fires\n   // that control's click, and the workbench does not perform a\n   // different write on top of it. Focusing 「取消」 and pressing Enter\n   // has to CANCEL -- not add the project.\n   if(hasNativeEnterAction(target))return;\n   if(selected&&source&&draft!==source.content){void save();e.preventDefault();return;}",
    replace: "   // The rejected behaviour, restored: Enter is the workbench's own\n   // command wherever it lands, and it performs a write of its own.\n   if(dialog&&projectPath){void addProject();e.preventDefault();return;}\n   if(tab==='security'&&keyName&&keySecret){void saveKey();e.preventDefault();return;}\n   if(selected&&source&&draft!==source.content){void save();e.preventDefault();return;}",
  },
  {
    id: 'V3 the previous project\'s catalogue is not cleared on a switch',
    file: VIEW,
    find: "  setCatalog({tests:[],files:[],warning:'',uidVersion:0,projectUid:''});\n  setCatalogueRequest({phase:'pending'});",
    replace: "  setCatalogueRequest({phase:'pending'});",
  },
  {
    id: 'V4 the key handler is bound to the app shell, not to the document',
    file: VIEW,
    find: "  document.addEventListener('keydown',onWorkbenchKey);\n  return()=>document.removeEventListener('keydown',onWorkbenchKey);",
    replace: "  // the handler is not bound to the document",
  },
  {
    id: 'V5 Escape does NOT stop the run (the footer promises it -- the round-2 defect, restored)',
    file: VIEW,
    find: "   if(target_==='run'){\n    // The stop is REQUESTED, and the run's final status is decided by\n    // the engine when the process closes -- the same contract as the\n    // 「停止运行」 button.\n    if(live)void api(`/api/runs/${live.id}/stop`,'POST').then(()=>refresh()).catch(err=>notify((err as Error).message));\n    e.preventDefault();return;\n   }",
    replace: "   if(target_==='run'){\n    // the rejected behaviour, restored: Escape does not stop the run\n    e.preventDefault();return;\n   }",
  },
  {
    id: 'V6 Ctrl+P inside the dialog is NOT consumed (the key leaks to the browser -- the round-2 regression, restored)',
    file: VIEW,
    find: "   if(dialog){e.preventDefault();return;}\n   searchRef.current?.focus();e.preventDefault();return;",
    replace: "   if(dialog)return;\n   searchRef.current?.focus();e.preventDefault();return;",
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
 * The directories that are never copied out of the REPOSITORY.
 *
 * `node_modules` is copied in SEPARATELY and on purpose: Turbopack
 * refuses to resolve packages that live outside its workspace root, so
 * a junction is not enough -- the dependency tree has to be a real
 * copy inside the tree.
 */
const SKIP_DIRS = new Set(['.next', 'out', '.git', 'node_modules']);

/** The directories that are never copied out of a BUILT tree. */
const SKIP_BUILD_DIRS = new Set(['.next', 'out', '.git']);

/**
 * The copy filter.
 *
 * The check is on a PATH SEGMENT, not on a substring: a substring check
 * for "out" also matches `next/dist/build/output/`, and dropping those
 * files leaves the Next.js CLI unable to start -- the build then fails
 * with a MODULE_NOT_FOUND that has nothing to do with the mutation.
 *
 * @param {Set<string>} skip
 */
function copyFilter(skip) {
  return (src) => {
    const parts = src.split(/[\\/]/);
    return !parts.some((p) => skip.has(p));
  };
}

/**
 * Clone a directory tree with HARD LINKS for the files.
 *
 * The mutated trees differ from the base tree in ONE file, so copying
 * the whole dependency tree for each of them would cost gigabytes and
 * minutes. A hard link is the same bytes with another name: the tree
 * looks complete, and writing to one of the copies writes to the
 * shared inode -- which is exactly what the mutation needs (it edits
 * `page.tsx`, which is copied, not linked).
 *
 * A hard link cannot cross a volume, so a failure falls back to a real
 * copy for that file.
 *
 * @param {string} src
 * @param {string} dst
 */
function cloneTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      cloneTree(from, to);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else {
      try {
        fs.linkSync(from, to);
      } catch {
        fs.copyFileSync(from, to);
      }
    }
  }
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

/**
 * Apply a mutation to a file and report whether it applied.
 *
 * The source is normalised to LF for the match: the checkout is CRLF
 * on Windows (core.autocrlf=true) and LF elsewhere, and a mutation
 * that is written with the other line ending would silently not
 * apply -- which the probe must report as a broken probe, never as a
 * result.
 *
 * The target is REMOVED before the new content is written. The mutated
 * trees share their files with the base tree through hard links, and
 * writing through a link would change the base tree as well -- so the
 * link is broken first and the file becomes its own inode.
 *
 * @returns {{ok:true,text:string}|{ok:false,reason:string}}
 */
function applyMutation(tree, mutation) {
  const target = path.join(tree, mutation.file);
  if (!fs.existsSync(target)) return { ok: false, reason: `the file ${mutation.file} is missing` };
  const before = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  if (!before.includes(mutation.find)) {
    return { ok: false, reason: 'the mutation did not apply -- the probe is broken' };
  }
  const after = before.replace(mutation.find, mutation.replace);
  if (after === before) {
    return { ok: false, reason: 'the mutation did not change the file' };
  }
  fs.rmSync(target);
  fs.writeFileSync(target, after, 'utf8');
  return { ok: true, text: after };
}

/* ------------------------------------------------------------------ */
/* 1. the MODEL mutations -- caught by the unit tests                 */
/* ------------------------------------------------------------------ */
console.log('=== the model mutations (the unit tests must go red) ===');
for (const mutation of MODEL_MUTATIONS) {
  const tree = makeTree();
  const applied = applyMutation(tree, mutation);
  if (!applied.ok) {
    check(mutation.id, false, applied.reason);
    continue;
  }
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

/* ------------------------------------------------------------------ */
/* 2. the VIEW mutations -- caught by the system test                  */
/* ------------------------------------------------------------------ */
console.log('');
console.log('=== the view mutations (the system test must go red) ===');
console.log('  (each mutation is built and driven in a real browser -- this takes a while)');

// The BASE tree: the repository as it is, built once. Its result is the
// control -- the system test must be GREEN on it, or a red mutation
// would prove nothing.
const baseTree = path.join(scratch, 'base');
fs.mkdirSync(baseTree, { recursive: true });
for (const entry of ['apps', 'server', 'examples', 'tools', 'package.json']) {
  fs.cpSync(path.join(repo, entry), path.join(baseTree, entry), {
    recursive: true,
    filter: copyFilter(SKIP_DIRS),
  });
}
// Turbopack refuses to resolve packages outside its workspace root, so
// the dependency tree is COPIED, not linked.
console.log('  copying the studio dependencies into the base tree ...');
fs.cpSync(path.join(repo, 'apps', 'studio', 'node_modules'),
  path.join(baseTree, 'apps', 'studio', 'node_modules'), { recursive: true });

/** Build the static export of a tree. */
function buildTree(tree) {
  const next = path.join(tree, 'apps', 'studio', 'node_modules', 'next', 'dist', 'bin', 'next');
  const r = spawnSync(process.execPath, [next, 'build'], {
    cwd: path.join(tree, 'apps', 'studio'),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=2048' },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Run the system test against a built tree. */
function runSystemTest(tree, label) {
  const r = spawnSync(process.execPath,
    ['tools/ats111-probes/st-ats111.mjs', '.', path.join(scratch, 'st-scratch'), studioNodeModules],
    { cwd: tree, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1536' } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const result = /RESULT: (\d+)\/(\d+)/.exec(out);
  const failing = out.split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5, 120));
  return {
    code: r.status,
    passed: result ? Number(result[1]) : 0,
    total: result ? Number(result[2]) : 0,
    failing,
    out,
  };
}

// The control: the system test must be GREEN on the unmutated tree.
const baseBuild = buildTree(baseTree);
if (baseBuild.code !== 0) {
  check('the control build succeeds', false, baseBuild.out.slice(-800));
} else {
  check('the control build succeeds', true);
  const control = runSystemTest(baseTree);
  check('the CONTROL run is GREEN (the system test passes on the delivered tree)',
    control.code === 0 && control.passed === control.total,
    `${control.passed}/${control.total}${control.failing.length ? ` failing: ${control.failing.join(' | ')}` : ''}`);
}

for (const mutation of VIEW_MUTATIONS) {
  // The mutated tree is a COPY of the base tree, so the dependencies
  // are already in place and the copy is cheap.
  const tree = path.join(scratch, `view-${Math.random().toString(36).slice(2, 8)}`);
  // The tree is CLONED, not copied: the files are hard links to the
  // base tree's, so the clone costs no disk space. The mutation breaks
  // the link before it writes (see `applyMutation`), so the base tree
  // is never modified.
  cloneTree(baseTree, tree);
  // The build output of the base tree is not part of the clone: each
  // mutated tree builds its own.
  fs.rmSync(path.join(tree, 'apps', 'studio', 'out'), { recursive: true, force: true });
  fs.rmSync(path.join(tree, 'apps', 'studio', '.next'), { recursive: true, force: true });
  const applied = applyMutation(tree, mutation);
  if (!applied.ok) {
    check(mutation.id, false, applied.reason);
    continue;
  }
  const built = buildTree(tree);
  if (built.code !== 0) {
    check(mutation.id, false, `the mutated tree does not build: ${built.out.slice(-500)}`);
    continue;
  }
  const result = runSystemTest(tree);
  // The mutation must make the system test RED.
  const caught = result.code !== 0 || result.passed !== result.total;
  check(
    mutation.id,
    caught,
    caught
      ? `caught (${result.passed}/${result.total}; failing: ${result.failing.join(' | ') || 'the run did not finish'})`
      : `the system test stayed GREEN (${result.passed}/${result.total}) -- no check covers this behaviour`,
  );
}

console.log('');
console.log(`scratch: ${scratch}`);
console.log(`RESULT: ${passed}/${total}`);
process.exitCode = passed === total ? 0 : 1;
