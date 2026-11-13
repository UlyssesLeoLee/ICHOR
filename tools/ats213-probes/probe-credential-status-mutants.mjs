#!/usr/bin/env node
/**
 * ATS-213 ｜ 变异体（mutants）—— 证明新加的 ST **真的**会变红
 *
 * 一条「PASS」的断言只有在它**能失败**的时候才有意义。一个恒真的断言在
 * 缺陷存在时也是绿的，于是它证明不了任何事。
 *
 * 本探针把交付树里的两处**修复**改回缺陷的样子，在一份**副本**上（交付树
 * 本身不动），**重新构建**那份副本，然后对它跑**同一支 ST**：
 *
 *   M-U1a  把「不可用密钥」的说明恢复成「只有出现 not-configured 才改
 *          文案」——缺陷形态：凭据库不可达时写着「全部可用」。
 *   M-U3   把引用列表恢复成「只由 credStatuses 渲染」——缺陷形态：状态读取
 *          失败时引用与删除按钮整个消失。
 *
 * 两个变异体都必须让对应的 ST 判定**变红**（报告缺陷存在），而**未变异
 * 的交付树**必须让同一支 ST **全绿**。两件事都成立，这支 ST 才有牙齿。
 *
 * S1 的变异体在模块层做：它不需要浏览器，只需要真的驱动那份被改回去的
 * `statusAll()`。
 *
 * 用法：node tools/ats213-probes/probe-credential-status-mutants.mjs
 * 可选：ATS213_PLAYWRIGHT_CORE=<playwright-core 目录>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..', '..');
// The scratch lives on D: -- the C: pagefile is capped at 8 GB, and a full
// C: makes unrelated processes die. The name is short on purpose: the
// mutant trees carry a copy of the app, and a long path plus a deep
// node_modules junction runs into the Windows MAX_PATH limit.
const scratchRoot = process.env.ATS213_MUTANT_SCRATCH
  || 'D:/hermes-multica/home/cache/scratch/ats213-mut';
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'm-'));
const coreDir = process.env.ATS213_PLAYWRIGHT_CORE || 'D:/ICHOR/examples/sample-playwright/node_modules/playwright-core';
const stProbe = path.join(repo, 'tools', 'ats213-probes', 'st-credential-status-failures.mjs');
const results = [];
const report = (id, ok, detail) => {
  results.push({ id, ok });
  console.log(`${ok ? 'OK   ' : 'FAIL '}  ${id}  ${detail}`);
};

/**
 * Copies a directory tree.
 *
 * `fs.cpSync` is not used for the big trees: on Windows it reports
 * EINPROGRESS on a directory that is being written while it is read. The
 * native `robocopy` does the same job without that failure mode, and it is
 * an order of magnitude faster on node_modules.
 */
function copy(from, to) {
  if (!fs.existsSync(from)) return;
  const result = spawnSync('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'], {
    encoding: 'utf8', timeout: 600000,
  });
  // robocopy reports success as 0..7; anything above 7 is a real failure.
  if (result.status > 7) {
    throw new Error(`robocopy ${from} -> ${to} failed with ${result.status}: ${result.stdout || ''}${result.stderr || ''}`);
  }
}

/**
 * Builds a COPY of the tree that the ST can be run against.
 *
 * The copy holds the source of the app and the server, plus a COPY of
 * `node_modules`. The copy is necessary: Turbopack refuses to resolve a
 * package through a link that points outside the workspace root ("files
 * outside of the workspace root are not compiled"), and a junction to the
 * real installation therefore produces a build error rather than a build.
 *
 * The `node_modules` copy is made ONCE and then REUSED by every mutant, by
 * moving it into the tree that is being built. Three copies would not fit
 * on the disk, and one copy is enough: a mutant differs from the delivery
 * only in `app/page.tsx`.
 */
const sharedModules = { dir: null };

function prepareSharedModules() {
  if (sharedModules.dir) return sharedModules.dir;
  const dir = path.join(scratch, 'node_modules');
  const from = path.join(repo, 'apps', 'studio', 'node_modules');
  if (fs.existsSync(from)) copy(from, dir);
  sharedModules.dir = dir;
  return dir;
}

function copyTree(mutate) {
  const dir = path.join(scratch, `tree-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  copy(path.join(repo, 'server'), path.join(dir, 'server'));
  // The workspace root's package.json is part of the build: Next.js
  // resolves the workspace root from it, and a tree without one is not a
  // buildable workspace.
  for (const name of ['package.json']) {
    const from = path.join(repo, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, name));
  }
  const studio = path.join(dir, 'apps', 'studio');
  fs.mkdirSync(studio, { recursive: true });
  for (const name of ['app', 'lib', 'public']) {
    copy(path.join(repo, 'apps', 'studio', name), path.join(studio, name));
  }
  for (const name of ['package.json', 'next.config.mjs', 'tsconfig.json', 'next-env.d.ts']) {
    const from = path.join(repo, 'apps', 'studio', name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(studio, name));
  }
  // The shared copy is MOVED into this tree, so only one copy exists at any
  // moment. It is moved back after the build.
  const modules = prepareSharedModules();
  const target = path.join(studio, 'node_modules');
  if (fs.existsSync(modules)) fs.renameSync(modules, target);
  if (mutate) mutate(path.join(studio, 'app', 'page.tsx'));
  const build = spawnSync(process.execPath, [path.join(target, 'next', 'dist', 'bin', 'next'), 'build'], {
    cwd: studio, encoding: 'utf8', timeout: 600000, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  if (build.status !== 0) {
    throw new Error(`the mutant tree did not build:\n${(build.stdout || '').slice(-2000)}\n${(build.stderr || '').slice(-2000)}`);
  }
  // The copy goes back to the pool for the next mutant.
  if (fs.existsSync(target)) fs.renameSync(target, modules);
  return dir;
}

/** Runs the ST against a tree and returns its verdicts. */
function runSt(tree, shots) {
  const out = spawnSync(process.execPath, [stProbe, shots], {
    cwd: repo, encoding: 'utf8', timeout: 600000,
    env: { ...process.env, ATS213_PLAYWRIGHT_CORE: coreDir, ATS213_TREE: tree },
  });
  const text = `${out.stdout || ''}\n${out.stderr || ''}`;
  const verdicts = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(PASS|FAIL)\s+(\S+)\s/.exec(line);
    if (m) verdicts[m[2]] = m[1] === 'PASS';
  }
  return { verdicts, text, status: out.status };
}

/**
 * Removes a tree.
 *
 * The mutant trees are removed as soon as they have been measured: the disk
 * is a shared resource, and three mutant trees plus their build artefacts
 * would be more than it has to spare. `robocopy /MIR` on an empty source
 * is the reliable way to remove a tree that contains JUNCTIONS -- a plain
 * `rm -rf` follows them and would delete the real installation.
 */
function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  const empty = path.join(scratch, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  spawnSync('robocopy', [empty, dir, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'], {
    encoding: 'utf8', timeout: 300000,
  });
  // The shared `node_modules` copy lives in the scratch, NOT in the tree --
  // but a tree that still holds it (a build that failed) would take it away.
  if (sharedModules.dir && fs.existsSync(sharedModules.dir)) {
    fs.mkdirSync(sharedModules.dir, { recursive: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 1. the DELIVERY tree: the ST must be green
{
  const shots = path.join(scratch, 'shots-delivery');
  const { verdicts, text } = runSt(repo, shots);
  const failed = Object.entries(verdicts).filter(([, ok]) => !ok).map(([id]) => id);
  report('DELIVERY-ST', failed.length === 0 && Object.keys(verdicts).length > 0,
    `the ST on the delivery tree: ${Object.keys(verdicts).length} checks, failing: ${failed.join(', ') || 'none'}`);
  if (failed.length) console.log(text.slice(-3000));
}

// --- 2. M-U1a: the caption is the defect form again
{
  const tree = copyTree((page) => {
    const src = fs.readFileSync(page, 'utf8');
    const mutant = src.replace(
      /\{credUnavailableCaption\(credStatuses,!!credStatusError\)\}/,
      "{credStatuses.some(s=>s.status==='not-configured')?'未配置或取不到':'全部可用'}",
    );
    if (mutant === src) throw new Error('the M-U1a mutation did not apply');
    fs.writeFileSync(page, mutant, 'utf8');
  });
  const { verdicts, text } = runSt(tree, path.join(scratch, 'shots-m-u1a'));
  report('M-U1a', verdicts['U1a'] === false,
    `the mutant caption makes the ST's U1a verdict ${verdicts['U1a'] === false ? 'RED (the defect is caught)' : 'GREEN (the ST is blind)'}`);
  if (verdicts['U1a'] !== false) console.log(text.slice(-3000));
  removeTree(tree);
}
// --- 3. M-U3: the reference list is rendered from the statuses again
{
  const tree = copyTree((page) => {
    const src = fs.readFileSync(page, 'utf8');
    const mutant = src.replace(
      /\{credentials\.filter\(c=>!credStatuses\.some\(s=>s\.id===c\.id\)\)\.map\(c=>[\s\S]*?删除<\/button><\/div>\)\}/,
      '',
    );
    if (mutant === src) throw new Error('the M-U3 mutation did not apply');
    fs.writeFileSync(page, mutant, 'utf8');
  });
  const { verdicts, text } = runSt(tree, path.join(scratch, 'shots-m-u3'));
  report('M-U3', verdicts['U3'] === false,
    `the mutant list makes the ST's U3 verdict ${verdicts['U3'] === false ? 'RED (the defect is caught)' : 'GREEN (the ST is blind)'}`);
  if (verdicts['U3'] !== false) console.log(text.slice(-3000));
  removeTree(tree);
}

// --- 4. M-S1: statusAll() re-reads the index per entry again
{
  const src = fs.readFileSync(path.join(repo, 'server', 'security', 'credentials.mjs'), 'utf8');
  // The mutation works on the SOURCE TEXT, so it must not depend on the
  // line endings: the file in the working tree uses CRLF, the blob in the
  // repository uses LF, and a probe that only matches one of them silently
  // does nothing. Every replacement is therefore written as a REGULAR
  // EXPRESSION whose line terminator is `\r?\n`.
  //
  // The mutant is the ORIGINAL defect, restored in two moves:
  //
  //   1. the walk re-reads the index for every entry, so a reference that
  //      is deleted mid-walk is simply NOT THERE any more;
  //   2. the walk has no per-entry catch, so one entry that cannot be
  //      measured takes the whole list down.
  //
  // The catch block is removed by its WHOLE TEXT, and the removal is
  // verified: a probe whose mutation silently does nothing would report a
  // green mutant and prove nothing.
  const walkStart = 'const index = loadCredentialIndex(indexFile);';
  const catchStart = '      try {';
  const catchEnd = '          checkedAt: now(),\r\n        });\r\n      }\r\n';
  const catchEndLf = catchEnd.replace(/\r\n/g, '\n');
  // Move 1: the walk re-reads the index for every entry.
  const mutant0 = src
    .replace(
      /const index = loadCredentialIndex\(indexFile\);\r?\n    const out = \[\];\r?\n    for \(const entry of index\.credentials\) \{/,
      'const out = [];\r\n    for (const entry of loadCredentialIndex(indexFile).credentials) {',
    )
    .replace('out.push(await status(entry.id, entry));', 'out.push(await status(entry.id));');
  if (mutant0 === src) throw new Error('the M-S1 mutation did not apply (the walk still reads one snapshot)');
  const end = mutant0.includes(catchEnd) ? catchEnd : catchEndLf;
  const catchAt = mutant0.indexOf(catchStart);
  const endAt = mutant0.indexOf(end, catchAt);
  if (catchAt < 0 || endAt < 0) throw new Error('the M-S1 mutation could not find the per-entry catch block');
  const mutant = mutant0
    .slice(0, catchAt)
    + '      out.push(await status(entry.id));\r\n'
    + mutant0.slice(endAt + end.length);
  if (mutant === mutant0) throw new Error('the M-S1 mutation did not apply');
  const dir = path.join(scratch, 'tree-m-s1');
  fs.mkdirSync(path.join(dir, 'server', 'security'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', 'security', 'credentials.mjs'), mutant, 'utf8');
  const mod = await import(pathToFileURL(path.join(dir, 'server', 'security', 'credentials.mjs')).href);
  const { createCredentialStore } = mod;
  const indexFile = path.join(dir, 'index.json');
  const secrets = new Map();
  let store;
  const backend = {
    name: 'racing-vault',
    available: async () => true,
    async write(id, secret) { secrets.set(id, secret); },
    async read(id) {
      if (!secrets.has(id)) throw new Error('CREDENTIAL_NOT_FOUND');
      return secrets.get(id);
    },
    // The status surface measures the store with `probe()`, so the fake
    // backend HAS to answer a probe. Without it the walk sees a broken
    // backend on every entry, the per-entry error path swallows it, and
    // the delete the control depends on never lands -- the control would
    // then measure a tree on which the defect was never triggered.
    async probe(id) {
      if (!secrets.has(id)) throw new Error('CREDENTIAL_NOT_FOUND');
      return 'PRESENT';
    },
    async remove(id) { secrets.delete(id); },
  };
  store = createCredentialStore({ indexFile, backend });
  const ids = [];
  for (const n of ['a', 'b', 'c']) {
    ids.push((await store.put({ name: `mut-${n}`, secret: `sk-mut-${n}`, purpose: 'other' })).id);
  }
  // The victim is the SECOND entry, and the DELETE lands BETWEEN the two
  // measurements: the walk has already read the list, the first entry is
  // measured, and the concurrent DELETE removes the second one. The walk
  // then measures an entry that is no longer there.
  //
  // The delete fires after the FIRST read returns, so the first measurement
  // completes normally and the break happens on the next one -- which is
  // exactly the window a concurrent DELETE has.
  const victim = ids[1];
  //
  // The delete must land on the call the walk ACTUALLY makes. The status
  // surface measures the store with `probe()`, so hooking `read()` would
  // never fire -- the negative control would then measure a tree on which
  // the defect was never triggered, and it would "prove" nothing.
  //
  // The hook is therefore on `probe()`, and the mutation is VERIFIED to
  // have applied: a probe that fires zero times cannot tell a blind
  // mutant from a mutant that was never built.
  let probes = 0;
  const backend2 = {
    ...backend,
    async probe(id) {
      probes++;
      const result = await backend.probe(id);
      if (probes === 1) await store.remove(victim);
      return result;
    },
  };
  const store2 = createCredentialStore({ indexFile, backend: backend2 });
  let outcome;
  try { const s = await store2.statusAll(); outcome = `returned ${s.length} statuses`; }
  catch (e) { outcome = `threw ${e.code || e.message}`; }
  // The negative control is only meaningful if the delete really landed
  // inside the walk. A mutant whose hook never fired reproduces nothing,
  // and reporting that as "the defect is reproduced" would be a false
  // green.
  const landed = probes > 0;
  report('M-S1', landed && /threw/.test(outcome),
    `the mutant statusAll() with a delete landing between two measurements -> ${outcome}; the delete fired ${probes} time(s) during the walk (the defect is reproduced)`);
}

const failed = results.filter((r) => !r.ok).map((r) => r.id);
console.log(`\nRESULT: ${failed.length ? `FAIL ${failed.join(',')}` : 'OK'} (${results.length} checks)`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
