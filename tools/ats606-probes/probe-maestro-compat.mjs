/**
 * ATS-606: the Maestro command inventory, established BEHAVIOURALLY.
 *
 * The official documentation lists 48 commands on its "Commands available"
 * index page. That list is a page of prose, and a prose list drifts. This
 * probe does not trust it: it asks MAESTRO ITSELF whether each command is a
 * real command, by running `maestro check-syntax` on a minimal Flow that uses
 * it. A command Maestro accepts is a command; one it rejects with
 * "Invalid Command" is not.
 *
 * Two negative controls are included on purpose. Without them, a probe that
 * accepted everything would look identical to a probe that works. The
 * controls are two spellings that are NOT commands (`notARealCommand`, and
 * `tapon` -- Maestro's commands are camelCase, and `tapOn` is the real one).
 * If the probe ever reports a control as a command, the probe is broken and
 * says so.
 *
 * WHY BEHAVIOURAL RATHER THAN BYTE-CODE: the byte-code inventory (the
 * `Yaml*Command` classes in maestro-orchestra.jar) is a second, independent
 * source, but it is derived from the same release. The behavioural check
 * asks the shipped parser, which is what a user actually hits.
 *
 * The command inventory is only HALF of ATS-606. The other half is the
 * platform's judgment: which of those commands the platform can map. That
 * judgment is checked here too -- the compatibility table lives in
 * docs/25-MOBILE-APP-TESTING.md §8.5, and this probe asserts that it covers
 * EVERY command the inventory found, that its counts add up, and that every
 * "mappable" verdict names a step kind that ATS-601 actually froze.
 *
 * usage: node tools/ats606-probes/probe-maestro-compat.mjs [--md docs/25-MOBILE-APP-TESTING.md]
 * exit:  0 all checks passed, 1 a check failed, 2 the probe could not run
 *        (no Maestro CLI / no Node) -- a skip is never reported as a pass.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(HERE, 'maestro-command-fixtures.json');

/**
 * The Maestro CLI to interrogate, as a COMMAND plus its ARGV PREFIX.
 *
 * The Maestro distribution ships TWO launchers next to each other:
 * `bin/maestro` (a POSIX shell script) and `bin/maestro.bat`. On Windows
 * Node cannot exec the shell script directly -- it is not a PE binary -- so
 * the probe has to run it THROUGH a shell, or use the .bat launcher.
 * Picking the wrong one makes every spawn fail with ENOENT, and a probe that
 * silently treats "the spawn failed" as "the command is valid" would then
 * report a perfect inventory for the wrong reason. That is exactly what the
 * negative controls are for.
 *
 * Override with ATS606_MAESTRO_BIN.
 */
function findMaestro() {
  const fromEnv = process.env.ATS606_MAESTRO_BIN;
  const roots = fromEnv
    ? [path.dirname(fromEnv)]
    : [
      'D:/AI-Tools/Maestro/bin',
      path.join(os.homedir(), '.maestro', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ];
  for (const dir of roots) {
    for (const name of ['maestro.bat', 'maestro']) {
      const p = path.join(dir, name);
      try {
        if (!fs.existsSync(p)) continue;
        if (name === 'maestro.bat' && process.platform !== 'win32') continue;
        if (name === 'maestro' && process.platform === 'win32') {
          // The shell script needs an interpreter; on Windows that is bash
          // (Git Bash / MSYS), which is not guaranteed to be there. Prefer
          // the .bat launcher on Windows.
          continue;
        }
        return { cmd: p, args: [] };
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

const MAESTRO = findMaestro();

function fail(msg) {
  console.log(`FAIL ${msg}`);
  failures.push(msg);
}
const failures = [];

function ok(msg) {
  console.log(`ok   ${msg}`);
}

/* ------------------------------------------------------------------ */
/* 1. The behavioural inventory                                        */
/* ------------------------------------------------------------------ */

const fixtures = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
const HEADER = `appId: ${fixtures.appId}\n---\n`;

/**
 * Asks Maestro whether a Flow body is a valid command.
 * Returns { accepted: boolean, output: string }.
 */
function checkSyntax(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats606-'));
  const file = path.join(dir, 'probe.yaml');
  try {
    fs.writeFileSync(file, HEADER + body + '\n', 'utf8');
    const res = spawnSync(MAESTRO.cmd, [...MAESTRO.args, 'check-syntax', file], {
      encoding: 'utf8',
      timeout: 120000,
      shell: process.platform === 'win32' && MAESTRO.cmd.endsWith('.bat'),
    });
    if (res.error) {
      // The spawn itself failed -- that is NOT a verdict about the command.
      // It must be loud, or a broken launcher looks like a clean inventory.
      fail(`the Maestro CLI could not be run (${res.error.message}) -- the inventory is NOT verified`);
      return { accepted: false, output: `spawn failed: ${res.error.message}`, status: null };
    }
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    // "Invalid Command: X" is Maestro's own verdict that the command does
    // not exist. Anything else (a parse error about arguments, say) means
    // the COMMAND was recognised -- the command exists, the usage may be
    // wrong.
    const invalidCommand = /Invalid Command/i.test(out);
    return { accepted: !invalidCommand, output: out, status: res.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (!MAESTRO) {
  console.log('SKIP no Maestro CLI found.');
  console.log('     Set ATS606_MAESTRO_BIN to the maestro executable to run this probe.');
  console.log('     The command inventory was NOT verified on this machine.');
  process.exit(2);
}

console.log(`=== ATS-606: the Maestro command inventory (behavioural) ===`);
console.log(`maestro : ${MAESTRO.cmd}`);
let version = '(unknown)';
try {
  version = execFileSync(MAESTRO.cmd, [...MAESTRO.args, '--version'], {
    encoding: 'utf8',
    timeout: 120000,
    shell: process.platform === 'win32' && MAESTRO.cmd.endsWith('.bat'),
  }).trim();
} catch {
  /* the version is nice to have, not a check */
}
console.log(`version : ${version}`);
console.log('');

const inventory = new Map();
for (const [name, body] of Object.entries(fixtures.commands)) {
  const r = checkSyntax(body);
  inventory.set(name, r.accepted);
  const mark = r.accepted ? 'ok  ' : 'FAIL';
  console.log(`${mark} command ${name.padEnd(24)} ${r.accepted ? 'accepted' : 'REJECTED'}`);
  if (!r.accepted) console.log(`       ${r.output.split('\n')[0]}`);
}

console.log('');
console.log('--- negative controls (these MUST be rejected) ---');
for (const [name, body] of Object.entries(fixtures.negativeControls)) {
  if (name.startsWith('_')) continue;
  const r = checkSyntax(body);
  if (r.accepted) {
    fail(`negative control "${name}" was ACCEPTED by Maestro -- the check cannot tell a real command from a typo`);
  } else {
    ok(`negative control "${name}" rejected as expected`);
  }
}

const accepted = [...inventory.entries()].filter(([, v]) => v).map(([k]) => k).sort();
const rejected = [...inventory.entries()].filter(([, v]) => !v).map(([k]) => k).sort();

console.log('');
console.log(`MAESTRO COMMAND INVENTORY: ${accepted.length} commands accepted, ${rejected.length} rejected`);
if (rejected.length) {
  console.log(`  rejected (not commands in this Maestro version): ${rejected.join(', ')}`);
}

/* ------------------------------------------------------------------ */
/* 2. The compatibility table in docs/25 §8.5                          */
/* ------------------------------------------------------------------ */

const mdArgIndex = process.argv.indexOf('--md');
const MD = mdArgIndex >= 0
  ? path.resolve(process.cwd(), process.argv[mdArgIndex + 1])
  : path.join(REPO, 'docs', '25-MOBILE-APP-TESTING.md');

if (!fs.existsSync(MD)) {
  fail(`the design document is missing: ${MD}`);
  process.exit(1);
}
const md = fs.readFileSync(MD, 'utf8');

console.log('');
console.log('--- the compatibility table (docs/25 §8.5) ---');

/**
 * Reads the §8.5 section out of the design document and extracts every
 * command the table mentions. The table is markdown, so the commands are
 * the backticked names in the command column of each sub-table.
 */
const section = md.slice(md.indexOf('## 8. iOS'), md.indexOf('## 9. 安全与信任边界'));
if (!section) fail('§8 of the design document is missing');

/** The three verdict groups, by their heading. */
function groupOf(heading) {
  if (/可映射/.test(heading) && !/部分可映射/.test(heading)) return 'mappable';
  if (/部分可映射/.test(heading)) return 'partial';
  return 'unmappable';
}

const verdicts = { mappable: [], partial: [], unmappable: [] };
const groupRe = /####\s+8\.5\.(\d)\s+(.+)/g;
let gm;
const groups = [];
while ((gm = groupRe.exec(section)) !== null) {
  groups.push({ index: gm[1], title: gm[2], at: gm.index });
}
groups.forEach((g, i) => {
  const end = i + 1 < groups.length ? groups[i + 1].at : section.length;
  g.body = section.slice(g.at, end);
});

for (const g of groups) {
  const verdict = groupOf(g.title);
  // The command column of a row may list SEVERAL commands separated by
  // '/' -- the table groups the ones that share a reason. Every backticked
  // name in that column counts, or a grouped row would count as one and
  // the totals would not add up.
  for (const line of g.body.split('\n')) {
    const firstCell = /^\|(.*?)\|/.exec(line);
    if (!firstCell) continue;
    for (const m of firstCell[1].matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)) {
      verdicts[verdict].push(m[1]);
    }
  }
}

const allVerdicts = [...verdicts.mappable, ...verdicts.partial, ...verdicts.unmappable];
const uniqVerdicts = [...new Set(allVerdicts)].sort();

console.log(`table: mappable=${verdicts.mappable.length} partial=${verdicts.partial.length} unmappable=${verdicts.unmappable.length}`);

// Every command the inventory found must have a verdict.
const missingVerdict = accepted.filter((c) => !uniqVerdicts.includes(c));
if (missingVerdict.length) {
  fail(`these Maestro commands have no verdict in §8.5: ${missingVerdict.join(', ')}`);
} else {
  ok(`every accepted Maestro command (${accepted.length}) has a verdict in §8.5`);
}

// Every command the table names must be a real Maestro command.
const phantomVerdict = uniqVerdicts.filter((c) => !accepted.includes(c) && !rejected.includes(c));
if (phantomVerdict.length) {
  fail(`§8.5 names commands that the inventory does not know: ${phantomVerdict.join(', ')}`);
} else {
  ok(`every command named in §8.5 is a real Maestro command (${uniqVerdicts.length})`);
}

// The rejected ones must be explained, not silently dropped.
const unexplained = rejected.filter((c) => !uniqVerdicts.includes(c));
if (unexplained.length) {
  fail(`these commands were REJECTED by Maestro but §8.5 does not mention them: ${unexplained.join(', ')}`);
} else {
  ok(`every rejected spelling is accounted for in §8.5`);
}

// The counts the document states must match the table.
const stated = /可映射\s*(\d+)\s*条\s*\/\s*部分可映射\s*(\d+)\s*条\s*\/\s*不映射\s*(\d+)\s*条/.exec(section);
if (!stated) {
  fail('§8.5 does not state the verdict counts in the form "可映射 N 条 / 部分可映射 N 条 / 不映射 N 条"');
} else {
  const [m, p, u] = [Number(stated[1]), Number(stated[2]), Number(stated[3])];
  const tm = verdicts.mappable.length;
  const tp = verdicts.partial.length;
  const tu = verdicts.unmappable.length;
  if (m !== tm || p !== tp || u !== tu) {
    fail(`§8.5 states ${m}/${p}/${u} but the table holds ${tm}/${tp}/${tu}`);
  } else {
    ok(`the stated counts (${m}/${p}/${u}) match the table`);
  }
}

// Every "mappable" verdict must name a step kind ATS-601 actually froze.
const stepKinds = readStepKinds();
console.log('');
console.log('--- the platform vocabulary (ATS-601 / ATS-602) ---');
if (!stepKinds) {
  fail('cannot read the ATS-601 step vocabulary from server/adapters/mobile-target.mjs');
} else {
  console.log(`ATS-601 step kinds: ${stepKinds.join(', ')}`);
  const badTargets = [];
  for (const line of verdicts.mappable.map(() => null) ? [] : []) void line;
  // A mappable row's second column is the platform's step kind. It must be
  // one of the ATS-601 kinds, or an explicit "no such step".
  for (const g of groups.filter((x) => groupOf(x.title) === 'mappable')) {
    for (const line of g.body.split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 3) continue;
      const name = /^`([A-Za-z][A-Za-z0-9]*)$/.exec(cells[1]);
      if (!name) continue;
      const target = cells[2].replace(/`/g, '').trim();
      if (target === '' || target === '—' || target.startsWith('不映射')) continue;
      if (!stepKinds.includes(target)) {
        badTargets.push(`${name[1]} -> ${target}`);
      }
    }
  }
  if (badTargets.length) {
    fail(`these mappable rows name a step kind that ATS-601 does not freeze: ${badTargets.join(', ')}`);
  } else {
    ok('every mappable row names a step kind that ATS-601 freezes');
  }
}

/**
 * Reads the ATS-601 step vocabulary straight out of the source, so the
 * check cannot pass by the table and the source agreeing by accident.
 */
function readStepKinds() {
  const src = path.join(REPO, 'server', 'adapters', 'mobile-target.mjs');
  if (!fs.existsSync(src)) return null;
  const text = fs.readFileSync(src, 'utf8');
  const m = /MOBILE_STEP_REQUIREMENTS\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(text);
  if (!m) return null;
  return [...m[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((x) => x[1]);
}

console.log('');
if (failures.length) {
  console.log(`COMPATIBILITY TABLE: FAIL (${failures.length} problem(s))`);
  process.exit(1);
}
console.log('COMPATIBILITY TABLE: OK');
console.log(`MAESTRO COMMAND INVENTORY: OK (${accepted.length} commands)`);
process.exit(0);
