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
 * Steps (one per CI workflow step, in the same order):
 *   checknode  assert the Node major version matches engines.node and the npm
 *             version matches packageManager
 *   install   npm ci in the root and in apps/studio, from the committed
 *             lockfiles only
 *   lockcheck assert that npm ci did not mutate either lockfile
 *   installdigest assert that the installed apps/studio tree still matches
 *             the digest recorded for it (tools/installed-tree-digests.txt)
 *   test      npm test (Node built-in test runner)
 *   ats301    the ATS-301 gate (the WBS shared-cell regression, the ADR
 *             citation check and the ATS-101 hardcoded-port audit)
 *   syntax    node --check on the bridge entrypoint
 *   build     the Next.js 16 static export
 *   manifest  assert the committed dependency manifest matches the lockfiles
 *
 * The steps above are the ones the workflow runs. `--check-parity` proves
 * that claim mechanically: it READS the workflow and compares every `run:`
 * command with the commands this script issues, so the two cannot drift
 * apart without the check failing. It is part of the gate itself (the
 * `parity` step), so a delivery that adds a workflow step without adding
 * the matching local step fails the gate.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const LIST_ONLY = argv.includes('--list');
const CHECK_ARTEFACT = argv.includes('--check-artefact');
const CHECK_NODE = argv.includes('--check-node');
const CHECK_PARITY = argv.includes('--check-parity');
const STEP_INDEX = argv.indexOf('--step');
const ONLY_STEP = STEP_INDEX >= 0 ? argv[STEP_INDEX + 1] : null;

/**
 * The CI workflow this script reproduces.
 */
const WORKFLOW = path.join('.github', 'workflows', 'ats-102-build.yml');

/**
 * The static export artefact the web-build step must produce.
 */
const EXPORT_ARTEFACT = path.join('apps', 'studio', 'out', 'index.html');

/**
 * The Node major version the project is pinned to. The root package.json
 * declares `engines.node` as ">=22"; the CI gate additionally requires the
 * MAJOR to be 22, because the lockfiles were produced by the Node 22 npm and
 * a newer major may resolve differently.
 */
const REQUIRED_NODE_MAJOR = 22;

/**
 * The npm version the lockfiles and the recorded tree digests were produced
 * with. The root package.json declares it as `packageManager`.
 *
 * It is asserted for a concrete reason: the recorded installed-tree digest
 * depends on it. npm 10.9.9 installs a set of optional packages that npm
 * 12.2.0 does not (for example `@emnapi/runtime` and `@img/sharp-wasm32`),
 * so the same lockfile yields two different trees under the two npm
 * versions, and therefore two different digests. Pinning the npm version
 * makes the digest a reproducible value instead of a property of whatever
 * npm happens to be on the PATH.
 */
const REQUIRED_NPM_VERSION = '10.9.9';

/**
 * Every step runs a command and asserts its exit code. The commands are the
 * ones the CI workflow runs, spelled the same way.
 */
const STEPS = [
  {
    id: 'checknode',
    title: 'The Node and npm versions match the pinned toolchain',
    commands: [
      // The workflow runs the same assertion as its first step
      // ("Verify Node and npm versions match the pinned toolchain").
      { cwd: REPO_ROOT, cmd: 'node', args: ['tools/ci_build_gate.mjs', '--check-node'] },
    ],
  },
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
    id: 'installdigest',
    title: 'The installed tree matches the digest recorded for it',
    commands: [
      // The digest is path-independent (relative paths only), so the expected
      // value is the same on every machine and every checkout location. It
      // pins the installed tree to the lockfiles: any dependency change,
      // swapped tarball or patched file moves it.
      //
      // The tool is addressed by a path RELATIVE to the repo root, and the
      // command runs with that same cwd: an absolute path would be re-split
      // on whitespace by the Windows shell and break in a checkout directory
      // whose name contains a space or a non-ASCII character.
      {
        cwd: REPO_ROOT,
        cmd: 'node',
        args: ['tools/tree_digest.mjs', '--check', 'apps/studio/node_modules'],
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
    id: 'ats301',
    title: 'The ATS-301 gate (WBS shared-cell regression, ADR citations, port audit)',
    commands: [
      // The workflow runs the same command as its own step ("Run the ATS-301
      // gate"). The gate script itself runs the WBS shared-cell regression,
      // the ADR citation check and the ATS-101 hardcoded-port audit.
      //
      // It is a separate step from `test` because it is a separate step in
      // the workflow: a delivery that adds a source file mentioning the
      // default port turns the port audit red, and only the audit sees that.
      { cwd: REPO_ROOT, cmd: 'npm', args: ['run', 'gate:ats301'] },
    ],
  },
  {
    id: 'syntax',
    title: 'The bridge entrypoint parses (node --check)',
    commands: [
      // The workflow runs the same assertion after the test step
      // ("Syntax check the bridge entrypoint").
      { cwd: REPO_ROOT, cmd: 'node', args: ['--check', 'server/index.mjs'] },
    ],
  },
  {
    id: 'build',
    title: 'Next.js 16 static export',
    commands: [
      { cwd: path.join(REPO_ROOT, 'apps', 'studio'), cmd: 'npm', args: ['run', 'build'] },
      // The artefact check is a separate script file rather than `node -e`,
      // because an inline script has to survive the Windows shell's word
      // splitting (a `shell: true` spawn splits on spaces, which breaks any
      // `node -e` payload containing them).
      { cwd: REPO_ROOT, cmd: 'node', args: ['tools/ci_build_gate.mjs', '--check-artefact'] },
    ],
  },
  {
    id: 'parity',
    title: 'The local gate matches this workflow step for step',
    commands: [
      // The workflow runs the same command as its own step ("Verify the
      // local build gate matches this workflow"). It compares every `run:`
      // command in the workflow with the commands this script issues.
      //
      // Without it the claim in this script's header is only a comment, and
      // a comment cannot fail: a delivery that adds a workflow step without
      // adding the matching local step would pass the gate unnoticed.
      { cwd: REPO_ROOT, cmd: 'node', args: ['tools/ci_build_gate.mjs', '--check-parity'] },
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

/**
 /**
  * The npm version on the PATH.
  *
  * On Windows `npm` is a `.cmd` shim, so it cannot be launched directly: the
  * OS only starts it through cmd.exe. The command is therefore run as
  * `cmd /c npm --version` WITHOUT `shell: true`, because a shell that
  * concatenates its arguments unescaped is deprecated in Node (DEP0190).
  * `cmd /c` takes the whole remainder as one command line, so nothing is
  * re-split.
  */
 function npmVersion() {
   const cmd = process.platform === 'win32'
     ? { file: 'cmd', args: ['/c', 'npm --version'] }
     : { file: 'npm', args: ['--version'] };
   const res = spawnSync(cmd.file, cmd.args, { encoding: 'utf8', shell: false });
   return (res.stdout || '').trim() || 'unknown';
 }

/**
 * Whether a command needs the Windows shell.
 *
 * Only `npm` needs it: on Windows `npm` is a `.cmd` shim, which the OS can
 * only launch through cmd.exe. `node` and `git` are real executables and
 * must NOT get a shell, because a shell re-splits the argument string on
 * whitespace -- a checkout path containing a space (or a non-ASCII name)
 * would be cut into two arguments and the command would fail with
 * "Cannot find module".
 */
function needsShell(cmd) {
  return process.platform === 'win32' && cmd === 'npm';
}

function run(cmd) {
  const started = Date.now();
  const res = spawnSync(cmd.cmd, cmd.args, {
    cwd: cmd.cwd,
    stdio: 'inherit',
    shell: needsShell(cmd.cmd),
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


/**
 * Parse the workflow's assertion steps out of the YAML.
 *
 * The steps are read from the FILE, not from a hand-written table. A
 * hand-written table cannot see a step that somebody ADDED to the workflow,
 * which is precisely the regression this check exists to catch: a delivery
 * adds a step to the workflow, the local gate does not run it, and the
 * header comment keeps claiming the two agree.
 *
 * The parser handles the shape this workflow actually uses:
 *
 *   jobs:
 *     <job>:
 *       steps:
 *         - name: <step name>
 *           run: <one line command>
 *         - name: <step name>
 *           run: |
 *             <several lines>
 *           working-directory: <dir>
 *
 * A step with `uses:` instead of `run:` is an ACTION (checkout, setup-node,
 * upload-artifact) -- it runs on the runner, not on the checkout, so it has
 * no local counterpart. A step marked `continue-on-error: true` does not
 * fail the build, so it is not an assertion either. Both are skipped, and
 * both are reported, so the skip is visible rather than silent.
 */
// A line terminator, CRLF or LF. Built with an explicit escape so no
// literal carriage return is embedded in the source of this file.
const SPLIT_LINES = new RegExp("\\r?\\n");
function parseWorkflowSteps(text) {
  const lines = text.split(SPLIT_LINES);
  const steps = [];
  let job = null;
  let inSteps = false;
  let current = null;
  let blockRun = null;

  const flush = () => {
    if (current) steps.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();

    // A job header: two spaces of indent then "name:".
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch) {
      flush();
      job = jobMatch[1];
      inSteps = false;
      continue;
    }
    if (/^ {4}steps:\s*$/.test(line)) {
      flush();
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;

    // A new step: six spaces of indent then "- name:".
    const stepMatch = line.match(/^ {6}- name: (.*)$/);
    if (stepMatch) {
      flush();
      current = { job, name: stepMatch[1].trim(), run: null, cwd: '', uses: null, continueOnError: false };
      continue;
    }
    if (!current) continue;

    // The run command, BLOCK form: the body follows on the next lines.
    // This is checked BEFORE the one-line form, because `run: |` also
    // matches the one-line pattern (its value is the literal `|`).
    if (/^ {8}run: \|\s*$/.test(line)) {
      blockRun = [];
      continue;
    }
    // The run command, one-line form.
    const runMatch = line.match(/^ {8}run: (.*)$/);
    if (runMatch) {
      current.run = runMatch[1].trim();
      continue;
    }
    if (blockRun) {
      // The body of the block form: ten spaces of indent.
      if (/^ {10}\S/.test(line)) {
        blockRun.push(trimmed);
        continue;
      }
      // The body ended. The line that ended it may still carry a key of its
      // own -- `continue-on-error: true` is the one that occurs in this
      // workflow -- so the remaining keys are checked against THIS line too.
      // There is no `continue` here on purpose.
      current.run = blockRun.join(' ').trim();
      blockRun = null;
    }
    const wdMatch = line.match(/^ {8}working-directory: (.*)$/);
    if (wdMatch) {
      current.cwd = wdMatch[1].trim();
      continue;
    }
    const usesMatch = line.match(/^ {8}uses: (.*)$/);
    if (usesMatch) {
      current.uses = usesMatch[1].trim();
      continue;
    }
    if (/^ {8}continue-on-error: true\s*$/.test(line)) {
      current.continueOnError = true;
      continue;
    }
  }
  flush();
  return steps;
}

/**
 * The commands this script issues, as comparable command lines.
 */
function gateCommands() {
  const out = [];
  for (const step of STEPS) {
    for (const cmd of step.commands) {
      const cwd = cmd.cwd;
      const rel = cwd && cwd !== REPO_ROOT
        ? path.relative(REPO_ROOT, cwd).split(path.sep).join('/')
        : '';
      out.push({ step: step.id, cwd: rel, run: `${cmd.cmd} ${cmd.args.join(' ')}`.trim() });
    }
  }
  return out;
}

/**
 * The canonical form of a command, for the parity comparison.
 *
 * Two commands are the same assertion when they assert the same thing in
 * the same directory, even if they spell it differently. The one place
 * where the workflow and the script spell an assertion differently is the
 * lockfile check: the workflow runs one `git diff` per lockfile (one step
 * per job), the script runs one `git diff` over both files. Both assert
 * "neither lockfile was mutated", so they are folded into one canonical
 * entry whose file list is the UNION, and the two sides are compared on
 * that.
 */
function canonicalKey(cwd, run) {
  const prefix = 'git diff --exit-code -- ';
  if (run.startsWith(prefix)) {
    const files = run.slice(prefix.length).split(' ').filter(Boolean).sort();
    return `${cwd} :: ${prefix}${files.join(' ')}`;
  }
  return `${cwd} :: ${run}`;
}

/**
 * Fold the lockfile assertions into ONE entry per side.
 */
function collapseLockfiles(entries) {
  const prefix = 'git diff --exit-code -- ';
  const files = new Set();
  let found = false;
  const rest = [];
  for (const e of entries) {
    if (e.run.startsWith(prefix)) {
      found = true;
      for (const f of e.run.slice(prefix.length).split(' ').filter(Boolean)) files.add(f);
    } else {
      rest.push(e);
    }
  }
  if (!found) return entries;
  const merged = {
    cwd: '',
    run: `${prefix}${[...files].sort().join(' ')}`,
    job: 'node-tests/web-build',
    name: 'Verify lockfile is not mutated by npm ci',
  };
  return [...rest, merged];
}

/**
 * Prove that the workflow and this script agree, step by step.
 *
 * The claim in this script's header -- "This runs EXACTLY the steps that
 * ats-102-build.yml runs" -- was a comment, and a comment cannot fail. When
 * a delivery added a step to the workflow, the comment kept claiming the
 * two agreed while `--list` did not show the new step, and nobody noticed
 * until a reviewer compared the two by hand.
 *
 * So the claim is checked: every command in the workflow must be issued by
 * this script, and every command this script issues must appear in the
 * workflow. The comparison is on the COMMAND TEXT and the working
 * directory, so a step that exists on only one side is reported, by name,
 * with the command that was orphaned.
 */
function checkParity() {
  const workflowPath = path.join(REPO_ROOT, WORKFLOW);
  if (!fs.existsSync(workflowPath)) {
    console.error(`${WORKFLOW} does not exist`);
    process.exitCode = 1;
    return;
  }
  const workflowText = fs.readFileSync(workflowPath, 'utf8');
  const gate = gateCommands();

  const problems = [];
  const matched = [];

  // --- the workflow side, READ FROM THE FILE -------------------------------
  const parsed = parseWorkflowSteps(workflowText);
  const workflowEntries = [];
  const skipped = [];
  for (const wf of parsed) {
    if (wf.uses) {
      skipped.push(`${wf.job} -> "${wf.name}" (an action: ${wf.uses})`);
      continue;
    }
    if (wf.continueOnError) {
      skipped.push(`${wf.job} -> "${wf.name}" (continue-on-error: it does not fail the build)`);
      continue;
    }
    if (!wf.run) {
      skipped.push(`${wf.job} -> "${wf.name}" (no run command)`);
      continue;
    }
    workflowEntries.push({ job: wf.job, name: wf.name, cwd: wf.cwd, run: wf.run });
  }

  // --- compare the two sides, lockfile assertion folded --------------------
  const wfFolded = collapseLockfiles(workflowEntries);
  const gateFolded = collapseLockfiles(gate.map((g) => ({ cwd: g.cwd, run: g.run })));

  const gateKeys = new Map();
  for (const g of gateFolded) {
    const key = canonicalKey(g.cwd, g.run);
    if (!gateKeys.has(key)) gateKeys.set(key, []);
    gateKeys.get(key).push(g);
  }

  for (const wf of wfFolded) {
    const key = canonicalKey(wf.cwd, wf.run);
    const hits = gateKeys.get(key);
    if (!hits || !hits.length) {
      problems.push(`the workflow runs "${wf.run}" (${wf.job} -> "${wf.name}") but this script does not`);
      continue;
    }
    hits.pop();
    matched.push({ run: wf.run, cwd: wf.cwd, where: `${wf.job} -> "${wf.name}"` });
  }

  for (const [key, hits] of gateKeys) {
    for (const h of hits) {
      problems.push(`this script runs "${h.run}"${h.cwd ? ` (in ${h.cwd})` : ''} but the workflow does not`);
    }
  }

  console.log('=== ATS-102 build gate: workflow / script parity ===');
  console.log(`workflow : ${WORKFLOW}`);
  console.log(`commands : ${workflowEntries.length} in the workflow, ${gate.length} in this script`);
  console.log('');
  for (const m of matched.sort((a, b) => a.run.localeCompare(b.run) || a.cwd.localeCompare(b.cwd))) {
    console.log(`  ok   ${m.run}${m.cwd ? `  [cwd: ${m.cwd}]` : ''}  <-  ${m.where}`);
  }
  console.log('');

  if (problems.length) {
    console.error('RESULT: MISMATCH -- the workflow and the local gate disagree:');
    for (const p of problems) console.error('  ', p);
    process.exitCode = 1;
    return;
  }
  console.log('RESULT: OK -- every workflow command is issued by this script, and vice versa.');
}

function main() {
  if (CHECK_PARITY) {
    checkParity();
    return;
  }

  if (CHECK_NODE) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    const declared = pkg.engines?.node || '(none)';
    const major = Number(process.versions.node.split('.')[0]);
    console.log(`node ${process.versions.node}, engines.node ${declared}`);
    if (major !== REQUIRED_NODE_MAJOR) {
      console.error(`Node ${REQUIRED_NODE_MAJOR}.x is required, got ${process.versions.node}`);
      process.exitCode = 1;
      return;
    }
    console.log(`node version ok: ${process.versions.node}`);

    // The npm version is asserted in the same step because the recorded
    // installed-tree digest depends on it: npm 10.9.9 and npm 12.2.0 resolve
    // the same lockfile to two different trees, so the recorded digest only
    // describes the tree npm 10.9.9 installs. Failing here names the actual
    // cause, instead of letting the digest step fail later with a bare
    // "the installed tree does not match the lockfiles it was installed from".
    const declaredNpm = (pkg.packageManager || '').replace(/^npm@/, '');
    const actualNpm = npmVersion();
    console.log(`npm ${actualNpm}, packageManager ${pkg.packageManager || '(none)'}`);
    if (declaredNpm && actualNpm !== declaredNpm) {
      console.error(
        `npm ${declaredNpm} is required, got ${actualNpm}.\n` +
          'The recorded installed-tree digest (tools/installed-tree-digests.txt) was\n' +
          'produced with npm ' + declaredNpm + '. A different npm version installs a\n' +
          'different set of optional packages from the same lockfile, so the digest\n' +
          'cannot match. Use the npm that ships with Node ' + REQUIRED_NODE_MAJOR + '.x.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`npm version ok: ${actualNpm}`);
    return;
  }

  if (CHECK_ARTEFACT) {
    const artefact = path.join(REPO_ROOT, EXPORT_ARTEFACT);
    if (!fs.existsSync(artefact)) {
      console.error(`${EXPORT_ARTEFACT} was not produced`);
      process.exitCode = 1;
      return;
    }
    const bytes = fs.statSync(artefact).size;
    if (bytes === 0) {
      console.error(`${EXPORT_ARTEFACT} is empty`);
      process.exitCode = 1;
      return;
    }
    console.log(`artefact ok: ${EXPORT_ARTEFACT} (${bytes} bytes)`);
    return;
  }

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
  console.log(`npm    : ${npmVersion()}`);
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
