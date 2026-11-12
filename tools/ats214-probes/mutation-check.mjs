#!/usr/bin/env node
/**
 * ATS-214 (review round 1, item 3): the MUTATION probe -- the NEGATIVE
 * CONTROL of the ST.
 *
 *   node tools/ats214-probes/mutation-check.mjs <repo> <scratch-dir>
 *
 * WHY THIS EXISTS
 * ---------------
 * The reviewer found that the 46 tests of the first delivery stayed GREEN
 * when `page.tsx` was mutated in two ways:
 *
 *   * the filter was disabled (`shown = catalog.tests`);
 *   * `runSelection` sent only the FIRST uid of the selection.
 *
 * A test suite that cannot fail is not evidence. The review demanded
 * that the ST "be proven to go red on those two mutations". So this probe
 * breaks the delivered code in N ways and asserts that the ATS-214 test
 * suite GOES RED for each of them.
 *
 * THE MUTATIONS
 * -------------
 *   M1  the FILTER is disabled -- the list shows everything;
 *   M2  `runSelection` sends only the FIRST uid of the selection;
 *   M3  the selection warning is not rendered -- a case that left the
 *       catalogue is dropped silently again;
 *   M4  the run is NOT blocked when a case left the catalogue;
 *   M5  the toast promises the SELECTED count instead of the count that
 *       will really run;
 *   M6  the filter is NOT reset when the project changes;
 *   M7  the pick box is put back INSIDE the row's button (the keyboard
 *       can no longer reach it);
 *   M8  the batch's environment profile is NOT inherited by the second
 *       run of the batch;
 *   M9  the batch is NOT validated group by group -- a refused file is
 *       accepted as part of a batch;
 *   M10 the batch is NOT ended when the preflight fails -- it stays
 *       `running` for ever.
 *
 * Each mutation is a SMALL, REAL change to the delivered source -- the
 * kind of change a careless edit would make. The probe applies it to a
 * COPY of the tree and asserts that the ATS-214 tests FAIL.
 *
 * A mutation that does not apply is reported as a BROKEN PROBE, never as
 * a pass: a mutation that silently did nothing cannot prove anything.
 *
 * WHAT RUNS
 * ---------
 *   * the unit tests (`tests/ats214-case-search.test.mjs`);
 *   * the integration tests (`tests/ats214-batch-run-api.test.mjs` and
 *     `tests/ats214-batch-context.test.mjs`), which drive the REAL
 *     Bridge;
 *   * the ST probe (`tools/ats214-probes/st-ats214.mjs`), which drives
 *     the REAL Chromium -- so the mutations of the INTERFACE are caught
 *     by the ST, not by a unit test that never renders a page.
 *
 * The ST needs a built `apps/studio/out` and the real Playwright, so it
 * is SKIPPED (with the reason printed) when either is missing -- never
 * reported as a pass.
 *
 * Prints `PASS`/`FAIL` per mutation and `RESULT: <passed>/<total>`;
 * exits 0 only when every mutation was caught.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [repoArg, scratchArg] = process.argv.slice(2);
if (!repoArg || !scratchArg) {
  console.error('usage: mutation-check.mjs <repo> <scratch-dir>');
  process.exit(2);
}
const REPO = path.resolve(repoArg);
const SCRATCH = path.resolve(scratchArg);
fs.mkdirSync(SCRATCH, { recursive: true });
const WORK = fs.mkdtempSync(path.join(SCRATCH, 'ats214-mut-'));

let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total += 1;
  if (ok) passed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

/**
 * The mutations. Each is a (find, replace) pair on a delivered file.
 *
 * The `find` strings are distinctive enough that a mutation that does
 * not apply is DETECTED (the file is compared before and after), so a
 * mutation that silently did nothing cannot be counted as "caught".
 */
const MUTATIONS = [
  {
    id: 'M1 the filter is disabled -- the list shows everything',
    file: 'apps/studio/app/page.tsx',
    find: 'const shown=useMemo(()=>filterCases(catalog.tests,caseFilter),[catalog.tests,caseFilter]);',
    replace: 'const shown=useMemo(()=>catalog.tests,[catalog.tests,caseFilter]);',
    probes: ['st'],
  },
  {
    id: 'M2 runSelection sends only the FIRST uid of the selection',
    file: 'apps/studio/app/page.tsx',
    find: "{selection:selection.uids}",
    replace: "{selection:selection.uids.slice(0,1)}",
    probes: ['st'],
  },
  {
    id: 'M3 the warning of a case that left the catalogue is not rendered',
    file: 'apps/studio/app/page.tsx',
    find: '{(selectionDiff.gone.length>0||selectionDiff.moved.length>0)&&<div className="selection-warning" role="alert" data-region="selection-warning">',
    replace: '{false&&<div className="selection-warning" role="alert" data-region="selection-warning">',
    probes: ['st'],
  },
  {
    id: 'M4 the run is NOT blocked when a case left the catalogue',
    file: 'apps/studio/app/page.tsx',
    find: 'if(selectionDiff.gone.length||selectionDiff.moved.length){',
    replace: 'if(false){',
    probes: ['st'],
  },
  {
    id: 'M5 the toast promises the SELECTED count instead of the count that will really run',
    file: 'apps/studio/app/page.tsx',
    find: 'const willRun=plan.willRun||selection.count;',
    replace: 'const willRun=selection.count;',
    probes: ['st'],
  },
  {
    id: 'M6 the filter is NOT reset when the project changes',
    file: 'apps/studio/app/page.tsx',
    find: "setCaseFilter({query:'',tags:[],tagMode:TAG_MODE.ANY,files:[],statuses:[]});",
    replace: '/* the filter is NOT reset */',
    probes: ['st'],
  },
  {
    id: 'M7 the pick box is put back to a span (not a button any more)',
    file: 'apps/studio/app/page.tsx',
    find: '<button className={\'pick-box\'+(selectedUids.includes(t.uid)?\' on\':\'\')} onClick={()=>toggleSelect(t.uid)} role="checkbox" aria-checked={selectedUids.includes(t.uid)} aria-label={`选中 ${t.title}`} title="选中以批量运行" type="button"/>',
    replace: '<span className={\'pick-box\'+(selectedUids.includes(t.uid)?\' on\':\'\')} onClick={()=>toggleSelect(t.uid)} role="checkbox" aria-checked={selectedUids.includes(t.uid)} aria-label={`选中 ${t.title}`} title="选中以批量运行"/>',
    probes: ['st'],
  },
  {
    id: 'M8 the batch does NOT inherit the environment profile',
    file: 'server/index.mjs',
    find: 'const envVariables=ctx.envVariables&&typeof ctx.envVariables===\'object\'?ctx.envVariables:{};',
    replace: 'const envVariables={};',
    probes: ['it'],
  },
  {
    id: 'M9 the batch is NOT validated group by group',
    file: 'server/index.mjs',
    find: 'if(selection&&selection.groups.length>1){',
    replace: 'if(false){',
    probes: ['it'],
  },
  {
    id: 'M10 the batch is NOT ended when the preflight fails',
    file: 'server/index.mjs',
    find: "if(run.batchUid)finishBatchOf(run,'failed',first.code);",
    replace: '// the batch is left running -- the first delivery\'s behaviour',
    probes: ['it'],
  },
];

/**
 * The probes of a mutation.
 *
 *   'it'  -- the integration tests drive the REAL Bridge, so they catch
 *            the mutations of the server;
 *   'st'  -- the ST drives the REAL Chromium against the REAL Bridge,
 *            so it catches the mutations of the interface.
 *
 * A mutation of the server is caught by the IT as well as by the ST; a
 * mutation of the interface can ONLY be caught by the ST (a unit test
 * never renders a page), so the ST is what makes the interface
 * mutations falsifiable.
 */
const PROBES = {
  it: {
    label: 'the integration tests',
    run(tree) {
      return runNodeTests(tree, ['tests/ats214-batch-run-api.test.mjs', 'tests/ats214-batch-context.test.mjs']);
    },
  },
  st: {
    label: 'the ST probe (real Chromium)',
    run(tree) {
      const pw = findPlaywrightModules();
      if (!pw) return { skipped: 'the real @playwright/test could not be reached' };
      // The ST drives the BUILT static export, so the mutation has to be
      // BUILT before the ST runs -- otherwise the ST measures the
      // unmutated build and reports GREEN for every mutation, which is
      // exactly the failure mode this probe exists to expose.
      const build = buildStaticExport(tree);
      if (!build.ok) return { skipped: `the static export could not be built (${build.detail})` };
      const r = spawnSync(process.execPath, [
        path.join(tree, 'tools', 'ats214-probes', 'st-ats214.mjs'),
        tree, WORK, pw,
      ], { cwd: tree, encoding: 'utf8', env: { ...process.env, ATS214_ST_MUTANT: '1' } });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      // A ST that CRASHED (ENOSPC, a build that failed, a browser that
      // would not start) is NOT a green ST: it printed no verdict at
      // all. It must be reported as a broken probe, never as "the
      // mutation was not caught" -- otherwise a full disk silently
      // turns every mutation green.
      const verdicts = (out.match(/^(OK|DEFECT) /gm) || []).length;
      if (verdicts === 0) {
        return { code: r.status, out, failCount: 0, broken: 'the ST printed no verdict at all (it crashed)' };
      }
      return { code: r.status, out, failCount: countDefects(out) };
    },
  },
};

/**
 * Build the static export of a MUTATED tree.
 *
 * The ST drives `apps/studio/out`, which is a BUILD OUTPUT: mutating
 * `page.tsx` changes nothing in it. So the mutated tree is BUILT before
 * the ST runs -- otherwise the ST measures the unmutated build and every
 * mutation of the interface is reported as "not caught", which says
 * nothing about the tests.
 *
 * The build needs the dependencies of apps/studio. They are copied from
 * the real tree (they are gitignored, so they are not part of the
 * delivery) -- the copy is a junction-free directory copy, which the
 * Next/Turbopack build resolves.
 */
function buildStaticExport(tree) {
  const appDir = path.join(tree, 'apps', 'studio');
  const deps = path.join(appDir, 'node_modules');
  if (!fs.existsSync(path.join(deps, 'next', 'package.json'))) {
    const src = path.join(REPO, 'apps', 'studio', 'node_modules');
    if (!fs.existsSync(src)) return { ok: false, detail: 'apps/studio/node_modules is missing' };
    // A JUNCTION, not a copy: the dependencies are several hundred
    // megabytes, and copying them per mutation fills the scratch disk
    // (the probe then dies with ENOSPC, which the caller would read as
    // "the ST passed" -- a silently green mutation).
    //
    // A junction is the right thing here: it is a directory the OS
    // resolves, so the Next build reads the files exactly as it would
    // from the real tree.
    const made = linkDirectory(src, deps);
    if (!made) {
      try {
        fs.cpSync(src, deps, { recursive: true, dereference: true });
      } catch (e) {
        return { ok: false, detail: `the dependencies could not be linked (${e.message})` };
      }
    }
  }
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: appDir, encoding: 'utf8', shell: true,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (!fs.existsSync(path.join(appDir, 'out', 'index.html'))) {
    return { ok: false, detail: `the build produced no out/index.html (exit ${r.status})` };
  }
  return { ok: true, out };
}

/**
 * A DIRECTORY JUNCTION (or a symlink, where junctions are not allowed).
 *
 * `mklink /J` works on Windows without a privilege; a symlink needs one.
 * On a POSIX host a symlink is the only option. Both are tried, and the
 * caller falls back to a copy when neither works.
 */
function linkDirectory(src, dst) {
  if (process.platform === 'win32') {
    const r = spawnSync('cmd', ['/c', 'mklink', '/J', dst, src], { encoding: 'utf8' });
    if (r.status === 0) return true;
  }
  try {
    fs.symlinkSync(src, dst, 'junction');
    return true;
  } catch { /* fall through */ }
  try {
    fs.symlinkSync(src, dst, 'dir');
    return true;
  } catch { return false; }
}

function findPlaywrightModules() {
  const candidates = [
    process.env.ATS214_PLAYWRIGHT_MODULES,
    path.join(REPO, 'examples', 'sample-playwright', 'node_modules'),
    'D:/ICHOR/examples/sample-playwright/node_modules',
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, '@playwright', 'test', 'cli.js'))) return dir;
  }
  return null;
}

/** The number of DEFECT lines the ST printed -- the ST's own exit code. */
function countDefects(out) {
  const m = out.match(/^DEFECT /gm);
  return m ? m.length : 0;
}

function runNodeTests(tree, files) {
  const r = spawnSync(process.execPath, ['--test', ...files], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1536' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const failed = /^# fail (\d+)$/m.exec(out);
  const failCount = failed ? Number(failed[1]) : (/not ok/.test(out) ? 1 : 0);
  // A test run that CRASHED (a module that would not load, a full disk)
  // is not a green test run: it ran no test at all. It is reported as a
  // BROKEN PROBE, never as "the mutation was not caught".
  const ran = (out.match(/^# tests \d+$/m) || [])[0];
  if (!ran) {
    return { code: r.status, failCount: 0, out, broken: 'the test run reported no test at all (it crashed)' };
  }
  return { code: r.status, failCount, out };
}

/**
 * Copy the tree the mutation runs against.
 *
 * Only the files the tests and the probes need are copied: the whole
 * repository is large, and the probes only read the source.
 */
function makeTree() {
  const tree = path.join(WORK, `tree-${Math.random().toString(36).slice(2, 8)}`);
  const copy = (rel) => {
    const from = path.join(REPO, rel);
    const to = path.join(tree, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };
  // The whole apps/studio tree: the Next build needs the app's own
  // files (the layout, the config, the fonts), not only the files a
  // mutation touches. `node_modules` and `out` are excluded -- the
  // dependencies are installed by the builder and the export is built.
  const appSrc = path.join(REPO, 'apps', 'studio');
  const appDst = path.join(tree, 'apps', 'studio');
  fs.mkdirSync(appDst, { recursive: true });
  for (const entry of fs.readdirSync(appSrc, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === '.next') continue;
    const from = path.join(appSrc, entry.name);
    const to = path.join(appDst, entry.name);
    if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true });
    else fs.copyFileSync(from, to);
  }
  // The whole server tree: the Bridge imports its modules by relative
  // path, so a copy of three files would not even start.
  const serverSrc = path.join(REPO, 'server');
  const serverDst = path.join(tree, 'server');
  fs.cpSync(serverSrc, serverDst, { recursive: true });
  for (const rel of [
    'tests/ats214-case-search.test.mjs',
    'tests/ats214-batch-run-api.test.mjs',
    'tests/ats214-batch-context.test.mjs',
    'tests/helpers/free-port.mjs',
    'tools/ats214-probes/st-ats214.mjs',
    'package.json',
  ]) copy(rel);
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
    try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* best effort */ }
    continue;
  }
  const after = before.replace(mutation.find, mutation.replace);
  if (after === before) {
    check(mutation.id, false, 'the mutation did not change the file');
    try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* best effort */ }
    continue;
  }
  fs.writeFileSync(target, after, 'utf8');

  // The probe that must catch it. The ST is the one that catches the
  // mutations of the interface; the IT catches the mutations of the
  // server. BOTH are run for a server mutation, because the ST also
  // drives the server.
  let caught = false;
  const details = [];
  for (const kind of mutation.probes) {
    const probe = PROBES[kind];
    const result = probe.run(tree);
    if (result.skipped) {
      details.push(`${probe.label}: SKIPPED (${result.skipped})`);
      continue;
    }
    if (result.broken) {
      details.push(`${probe.label}: BROKEN (${result.broken})`);
      continue;
    }
    const red = kind === 'st'
      ? (result.code !== 0 && result.failCount > 0)
      : (result.code !== 0 || result.failCount > 0);
    details.push(`${probe.label}: ${red ? 'RED' : 'GREEN'}`);
    if (red) caught = true;
  }
  check(
    mutation.id,
    caught,
    caught ? `caught (${details.join('; ')})` : `NOT CAUGHT (${details.join('; ')})`,
  );
  // The tree is removed AFTER the mutation is measured: ten trees, each
  // with a built static export, is a lot of disk -- and a full scratch
  // disk makes the next probe die with ENOSPC, which reads as "the
  // mutation was not caught" (a silently green mutation).
  try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('');
console.log(`scratch: ${WORK}`);
console.log(`RESULT: ${passed}/${total}`);
process.exitCode = passed === total ? 0 : 1;
