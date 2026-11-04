#!/usr/bin/env node
/**
 * ATS-102 -- the build gate, as a script.
 *
 * This runs EXACTLY the steps that .github/workflows/ats-102-build.yml runs,
 * so the gate can be reproduced locally on Windows / macOS / Linux without a
 * CI runner -- and so a reviewer can check that the workflow and this script
 * agree. The workflow calls the same commands; if a step changes here, it
 * must change there too.
 *
 * Usage:
 *   node tools/ci_build_gate.mjs              # run every step
 *   node tools/ci_build_gate.mjs --step test  # run one step
 *   node tools/ci_build_gate.mjs --list       # list the steps
 *
 * Steps:
 *   install   npm ci in the root and in apps/studio, from the committed
 *             lockfiles only
 *   lockcheck assert that npm ci did not mutate either lockfile
 *   test      npm test (Node built-in test runner)
 *   build     the Next.js 16 static export
 *   manifest  regenerate the dependency manifest and assert no drift
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const LIST_ONLY = argv.includes('--list');
const STEP_INDEX = argv.indexOf('--step');
const ONLY_STEP = STEP_INDEX >= 0 ? argv[STEP_INDEX + 1] : null;

/**
 * Every step runs a command and asserts its exit code. The commands are the
 * ones the CI workflow runs, spelled the same way.
 */
const STEPS = [
  {
    id: 'install',
    title: 'Clean install from the committed lockfiles (npm ci)',
    commands: [
      { cwd: REPO_ROOT, cmd: 'npm', args: ['ci', '--no-audit', '--no-fund'] },
      { cwd: path.join(REPO_ROOT, 'apps', 'studio'), cmd: 'npm', args: ['ci', '--no-audit', '--no-fund'] },
    ],
  },
  {
    id: 'lockcheck',
    title: 'npm ci did not mutate either lockfile',
    commands: [
      {
        cwd: REPO_ROOT,
        cmd: 'git',
        args: ['diff', '--exit-code', '--', 'package-lock.json', 'apps/studio/package-lock.json'],
      },
    ],
  },
  {
    id: 'test',
    title: 'Unit / integration tests (node --test)',
    commands: [
      { cwd: REPO_ROOT, cmd: 'npm', args: ['test'] },
    ],
  },
  {
    id: 'build',
    title: 'Next.js 16 static export',
    commands: [
      { cwd: path.join(REPO_ROOT, 'apps', 'studio'), cmd: 'npm', args: ['run', 'build'] },
      {
        cwd: REPO_ROOT,
        cmd: 'node',
        args: ['-e', "const fs=require('fs');if(!fs.existsSync('apps/studio/out/index.html')){console.error('apps/studio/out/index.html was not produced');process.exit(1)}console.log('artefact ok: apps/studio/out/index.html')"],
      },
    ],
  },
  {
    id: 'manifest',
    title: 'Dependency manifest is in sync with the lockfiles',
    commands: [
      { cwd: REPO_ROOT, cmd: 'node', args: ['tools/gen_dep_manifest.mjs', '--check'] },
    ],
  },
];

function run(cmd) {
  const started = Date.now();
  const res = spawnSync(cmd.cmd, cmd.args, {
    cwd: cmd.cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // On Windows the .cmd shims need the shell; on POSIX they must not get one.
    env: process.env,
  });
  const ms = Date.now() - started;
  if (res.error) {
    console.error(`  command failed to start: ${res.error.message}`);
    return 1;
  }
  if (res.status !== 0) {
    console.error(`  command exited with ${res.status} after ${ms} ms`);
    return res.status === null ? 1 : res.status;
  }
  console.log(`  ok (${ms} ms)`);
  return 0;
}

function main() {
  if (LIST_ONLY) {
    for (const step of STEPS) console.log(`${step.id}\t${step.title}`);
    return;
  }

  const selected = ONLY_STEP ? STEPS.filter((s) => s.id === ONLY_STEP) : STEPS;
  if (!selected.length) {
    console.error(`unknown step: ${ONLY_STEP}`);
    console.error(`known steps: ${STEPS.map((s) => s.id).join(', ')}`);
    process.exitCode = 2;
    return;
  }

  console.log('=== ATS-102 build gate ===');
  console.log(`node   : ${process.version}`);
  console.log(`npm    : ${(spawnSync('npm', ['--version'], { encoding: 'utf8' }) || {}).stdout?.trim() || 'unknown'}`);
  console.log(`repo   : ${REPO_ROOT}`);
  console.log('');

  const failures = [];
  for (const step of selected) {
    console.log(`--- [${step.id}] ${step.title}`);
    const started = Date.now();
    let failed = false;
    for (const cmd of step.commands) {
      const label = `${cmd.cmd} ${cmd.args.join(' ')}`;
      console.log(`  $ ${label}`);
      if (run(cmd) !== 0) {
        failed = true;
        break;
      }
    }
    const ms = Date.now() - started;
    if (failed) {
      console.error(`--- [${step.id}] FAILED after ${ms} ms`);
      failures.push(step.id);
    } else {
      console.log(`--- [${step.id}] PASSED (${ms} ms)`);
    }
    console.log('');
  }

  if (failures.length) {
    console.error(`RESULT: FAILED -- ${failures.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('RESULT: OK -- every build-gate step passed.');
}

main();
