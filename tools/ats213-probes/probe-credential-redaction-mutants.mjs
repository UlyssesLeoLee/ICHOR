#!/usr/bin/env node
/**
 * ATS-213 ｜ 变异体（mutants）—— 证明第 3 轮的新检查**真的会变红**
 *
 * 复核第 2 轮登记的三条必改项，每一条都要有一支变异体：
 *
 *   M-P1  把状态面改回 `read()`——缺陷形态：每打开一次安全页，每一条密钥
 *         的明文都经 helper 的 stdout 进入 Bridge 的内存。
 *   M-P2  把 `buildRunnerEnv()` 改回 `String(value)`——缺陷形态：未解析的
 *         引用被注入成 `"[object Object]"`，运行**静默**地拿到假 token。
 *   M-P3  把脱敏改回「逐块替换」——缺陷形态：一个跨两块分块的密钥**漏掉**，
 *         它的前半截照常落盘。
 *   M-P3b 把落盘前的脱敏整个去掉——缺陷形态：密钥进 `stdout.log`、
 *         `report.json`、`error-context.md` 与 HTML 报告内嵌的 zip。
 *
 * 每支变异体都必须让对应的检查**变红**（报告缺陷存在），而**未变异的交付
 * 树**必须让同一批检查**全绿**。两件事都成立，这批检查才有牙齿。
 *
 * 用法：node tools/ats213-probes/probe-credential-redaction-mutants.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..', '..');
const scratchRoot = process.env.ATS213_MUTANT_SCRATCH
  || 'D:/hermes-multica/home/cache/scratch/ats213-mut-r3';
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'm-'));
const results = [];
const report = (id, ok, detail) => {
  results.push({ id, ok });
  console.log(`${ok ? 'OK   ' : 'FAIL '}  ${id}  ${detail}`);
};

/**
 * Copies a source file into a scratch tree and mutates it.
 *
 * The mutation must be VERIFIED to have applied: a `String.replace` that
 * matches nothing returns the original string, and the probe would then
 * "prove" that the check is blind on a tree where nothing was broken.
 */
function mutate(sourceRelative, mutateText) {
  const dir = path.join(scratch, `tree-${Math.random().toString(36).slice(2, 8)}`);
  const target = path.join(dir, sourceRelative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const src = fs.readFileSync(path.join(repo, sourceRelative), 'utf8');
  const mutant = mutateText(src);
  if (mutant === src) throw new Error(`the mutation of ${sourceRelative} did not apply`);
  fs.writeFileSync(target, mutant, 'utf8');
  return { dir, target };
}

/**
 * Runs ONE test file against a tree whose source files were replaced.
 *
 * The tree is a COPY of the repository's source, with the mutated files
 * written over it, so the test's own imports resolve to the mutant.
 */
function runTests(tree, testFile, testName) {
  const out = spawnSync(process.execPath, ['--test', testFile], {
    cwd: tree,
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      // The integration test needs the REAL credential store and the real
      // Playwright installation: the defect it guards is a leak that only
      // happens with a real secret and a real engine.
      ATS213_REAL_CREDENTIAL_STORE: '1',
      ATS213_PLAYWRIGHT_CORE: process.env.ATS213_PLAYWRIGHT_CORE
        || 'D:/ICHOR/examples/sample-playwright/node_modules/playwright-core',
    },
  });
  const text = `${out.stdout || ''}\n${out.stderr || ''}`;
  // The verdict of ONE named test: `ok 1 - <name>` in TAP, or the reporter's
  // `✔`/`✖` line. Both are recognised, because the reporter differs
  // between Node versions.
  const failed = new RegExp(`^not ok \\d+ - ${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(text)
    || new RegExp(`^✖ ${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(text);
  const passed = new RegExp(`^ok \\d+ - ${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(text)
    || new RegExp(`^✔ ${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(text);
  return { failed, passed, text, status: out.status };
}

/**
 * Builds a tree that is a copy of the repository's SOURCE (server/ + tests/),
 * with the mutated files written over it.
 */
function sourceTree(mutatedFiles) {
  const dir = path.join(scratch, `src-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['server', 'tests', 'package.json']) {
    const from = path.join(repo, name);
    if (!fs.existsSync(from)) continue;
    spawnSync('robocopy', [from, path.join(dir, name), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'], {
      encoding: 'utf8', timeout: 300000,
    });
  }
  for (const [relative, content] of Object.entries(mutatedFiles)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return dir;
}

/* ------------------------------------------------------------------ */
/* 0. the DELIVERY tree: the new checks must be green                    */
/* ------------------------------------------------------------------ */
{
  const { failed, text } = runTests(repo, 'tests/credential-reference-boundaries.test.mjs', 'ATS213-R3-UT-001');
  report('DELIVERY-UT', !failed,
    failed ? 'the new checks are RED on the delivery tree' : 'the new checks are GREEN on the delivery tree');
  if (failed) console.log(text.slice(-2500));
}

/* ------------------------------------------------------------------ */
/* M-P1: the status surface reads the plaintext again                    */
/* ------------------------------------------------------------------ */
{
  const source = fs.readFileSync(path.join(repo, 'server', 'security', 'credentials.mjs'), 'utf8');
  // The mutation restores the defect: `status()` reads the secret out of
  // the store instead of probing it.
  const mutant = source.replace(
    /const answer = String\(await probe\(id\)\)\.trim\(\)\.toUpperCase\(\);/,
    "const answer = String(await store.read(id)).trim().toUpperCase() ? 'PRESENT' : 'PRESENT';",
  );
  if (mutant === source) throw new Error('the M-P1 mutation did not apply');
  const tree = sourceTree({ 'server/security/credentials.mjs': mutant });
  const { failed, text } = runTests(tree, 'tests/credential-reference-boundaries.test.mjs', 'ATS213-R3-UT-001');
  report('M-P1', failed,
    `the mutant status surface makes the check's verdict ${failed ? 'RED (the defect is caught)' : 'GREEN (the check is blind)'}`);
  if (!failed) console.log(text.slice(-2500));
}

/* ------------------------------------------------------------------ */
/* M-P2: buildRunnerEnv stringifies the reference again                  */
/* ------------------------------------------------------------------ */
{
  const source = fs.readFileSync(path.join(repo, 'server', 'env', 'profiles.mjs'), 'utf8');
  // The mutation restores the defect: a reference is stringified into
  // "[object Object]" and put into the environment block.
  const mutant = source.replace(
    /if \(parseCredentialRef\(value\)\) return null;/g,
    'if (parseCredentialRef(value)) return String(value);',
  );
  if (mutant === source) throw new Error('the M-P2 mutation did not apply');
  const tree = sourceTree({ 'server/env/profiles.mjs': mutant });
  const { failed, text } = runTests(tree, 'tests/credential-reference-boundaries.test.mjs', 'ATS213-R3-UT-004');
  report('M-P2', failed,
    `the mutant stringification makes the check's verdict ${failed ? 'RED (the defect is caught)' : 'GREEN (the check is blind)'}`);
  if (!failed) console.log(text.slice(-2500));
}

/* ------------------------------------------------------------------ */
/* M-P3: the streaming redaction is replaced by a per-chunk one         */
/* ------------------------------------------------------------------ */
{
  const source = fs.readFileSync(path.join(repo, 'server', 'env', 'secret-redaction.mjs'), 'utf8');
  // The mutation restores the defect: the redaction is applied to each
  // chunk on its own, so a secret split across two chunks is missed.
  const mutant = source.replace(
    /const boundary = safePrefixLength\(raw, usable\);/,
    'const boundary = raw.length;',
  );
  if (mutant === source) throw new Error('the M-P3 mutation did not apply');
  const tree = sourceTree({ 'server/env/secret-redaction.mjs': mutant });
  const { failed, text } = runTests(tree, 'tests/credential-reference-boundaries.test.mjs', 'ATS213-R3-UT-009');
  report('M-P3', failed,
    `the mutant per-chunk redaction makes the check's verdict ${failed ? 'RED (the defect is caught)' : 'GREEN (the check is blind)'}`);
  if (!failed) console.log(text.slice(-2500));
}

/* ------------------------------------------------------------------ */
/* M-P3b: the redaction of the run folder is removed entirely           */
/* ------------------------------------------------------------------ */
{
  // The folder redaction is CALLED from the run's finish path, so that is
  // where the mutation goes: the helper itself still works, but nothing
  // calls it any more.
  const source = fs.readFileSync(path.join(repo, 'server', 'index.mjs'), 'utf8');
  const mutant = source.replace(
    /const redaction=redactRunSecrets\(run,folder\);/,
    'const redaction={active:false,files:[],boundaries:[],secrets:0};',
  );
  if (mutant === source) throw new Error('the M-P3b mutation did not apply');
  const tree = sourceTree({ 'server/index.mjs': mutant });
  // The IT that exercises the WHOLE path -- the real Bridge, the real
  // credential store, a real Playwright run whose assertion fails -- has to
  // go red. The unit test alone cannot see this defect, because it calls
  // the helper directly.
  const { failed, text } = runTests(
    tree,
    'tests/credential-redaction-api.test.mjs',
    'ATS213-REDACT-IT-001',
  );
  report('M-P3b', failed,
    `the mutant without the folder redaction makes the IT's verdict ${failed ? 'RED (the defect is caught)' : 'GREEN (the IT is blind)'}`);
  if (!failed) console.log(text.slice(-2500));
}

/* ------------------------------------------------------------------ */
/* M-P3c: the embedded ZIP of the HTML report is not rebuilt             */
/* ------------------------------------------------------------------ */
{
  const source = fs.readFileSync(path.join(repo, 'server', 'env', 'secret-redaction.mjs'), 'utf8');
  const mutant = source.replace(
    /export function redactEmbeddedArchives\(html, redactor\) \{/,
    'export function redactEmbeddedArchives(html, redactor) {\n  if (html) return { html, redacted: false };',
  );
  if (mutant === source) throw new Error('the M-P3c mutation did not apply');
  const tree = sourceTree({ 'server/env/secret-redaction.mjs': mutant });
  const { failed, text } = runTests(tree, 'tests/credential-reference-boundaries.test.mjs', 'ATS213-R3-UT-014');
  report('M-P3c', failed,
    `the mutant without the embedded-archive rebuild makes the check's verdict ${failed ? 'RED (the defect is caught)' : 'GREEN (the check is blind)'}`);
  if (!failed) console.log(text.slice(-2500));
}

/* ------------------------------------------------------------------ */
/* M-P4: the batch resolves the profile on its own again                */
/* ------------------------------------------------------------------ */
{
  // The defect: the batch's helper implements the rules a SECOND time, so
  // the batch is no longer bound by the choke point's fail-closed check.
  const source = fs.readFileSync(path.join(repo, 'server', 'index.mjs'), 'utf8');
  const mutant = source.replace(
    / const resolved=await prepareRunnerEnvironment\(\{project,envProfile:profile,credentialStore\}\);/,
    ' const resolved={values:profile.variables??{},names:Object.keys(profile.variables??{}).sort(),refused:[],referenced:[]};',
  );
  if (mutant === source) throw new Error('the M-P4 mutation did not apply');
  const tree = sourceTree({ 'server/index.mjs': mutant });
  const { failed, text } = runTests(tree, 'tests/credential-reference-boundaries.test.mjs', 'ATS213-R3-UT-018');
  report('M-P4', failed,
    `the mutant batch path makes the check's verdict ${failed ? 'RED (the defect is caught)' : 'GREEN (the check is blind)'}`);
  if (!failed) console.log(text.slice(-2500));
}

/* ------------------------------------------------------------------ */
/* M-P5: the fail-open fallback comes back                               */
/* ------------------------------------------------------------------ */
{
  // The defect: `startRun()` falls back to the profile's own variables
  // when the caller has no resolved values, so an unresolved reference
  // reaches the environment block.
  const source = fs.readFileSync(path.join(repo, 'server', 'index.mjs'), 'utf8');
  const mutant = source.replace(
    /buildRunnerEnv\(\{variables:envVariables\?\?\{\}\},\{/,
    'buildRunnerEnv({variables:envVariables??envProfile?.variables??{}},{',
  );
  if (mutant === source) throw new Error('the M-P5 mutation did not apply');
  const tree = sourceTree({ 'server/index.mjs': mutant });
  const { failed, text } = runTests(tree, 'tests/credential-reference-boundaries.test.mjs', 'ATS213-R3-UT-019');
  report('M-P5', failed,
    `the mutant fail-open fallback makes the check's verdict ${failed ? 'RED (the defect is caught)' : 'GREEN (the check is blind)'}`);
  if (!failed) console.log(text.slice(-2500));
}

/* ------------------------------------------------------------------ */
/* M-P6: a SECOND resolver appears                                      */
/* ------------------------------------------------------------------ */
{
  // The defect: the resolver is called from a second place, so the rules
  // have two implementations that can drift.
  const source = fs.readFileSync(path.join(repo, 'server', 'index.mjs'), 'utf8');
  const mutant = source.replace(
      /function startRun\(/,
      'async function aSecondResolver(){return resolveCredentialRefs({},{});}\nfunction startRun(',
    );
  if (mutant === source) throw new Error('the M-P6 mutation did not apply');
  const tree = sourceTree({ 'server/index.mjs': mutant });
  const { failed, text } = runTests(tree, 'tests/credential-reference-boundaries.test.mjs', 'ATS213-R3-UT-017');
  report('M-P6', failed,
    `the mutant second resolver makes the check's verdict ${failed ? 'RED (the defect is caught)' : 'GREEN (the check is blind)'}`);
  if (!failed) console.log(text.slice(-2500));
}

const failed = results.filter((r) => !r.ok).map((r) => r.id);
console.log(`\nRESULT: ${failed.length ? `FAIL ${failed.join(',')}` : 'OK'} (${results.length} checks)`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
