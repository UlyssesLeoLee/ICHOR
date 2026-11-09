/**
 * ATS-606: the Maestro command inventory (BEHAVIOURAL), the platform's
 * import behaviour (MEASURED), and the compatibility table in
 * docs/25-MOBILE-APP-TESTING.md §8.5.
 *
 * WHAT THIS PROBE CHECKS
 * ----------------------
 * 1. THE INVENTORY. The official documentation lists 48 commands on its
 *    "Commands available" index page. That list is a page of prose, and a
 *    prose list drifts. This probe does not trust it: it asks MAESTRO ITSELF
 *    whether each command is a real command, by running `maestro
 *    check-syntax` on a minimal Flow that uses it. A command Maestro
 *    accepts is a command; one it rejects with "Invalid Command" is not.
 *
 *    Two negative controls are included on purpose. Without them, a probe
 *    that accepted everything would look identical to a probe that works.
 *    The controls are two spellings that are NOT commands (`notARealCommand`,
 *    and `tapon` -- Maestro's commands are camelCase, and `tapOn` is the
 *    real one). If the probe ever reports a control as a command, the probe
 *    is broken and says so.
 *
 * 2. THE IMPORT BEHAVIOUR. For every one of the 55 fixtures, the probe runs
 *    the platform's REAL importer (`parseFlow` + `importFlow` +
 *    `buildImportReport` from ATS-602) and records what actually happened:
 *    did the Maestro spelling become a platform step, or did it land in the
 *    import report as an unsupported step? This is the fact that round 1 of
 *    the review was about: the delivered table claimed 7 mappable commands
 *    while the importer actually maps 4.
 *
 * 3. THE TABLE. The §8.5 table is compared against 1 and 2 cell by cell:
 *    every command has a verdict, every verdict group is one of the three,
 *    the "importer behaviour" cell states what the importer really does,
 *    the parameter cell matches ATS-602's `STEP_ARGUMENTS`, and the stated
 *    counts match both the table and the measurement.
 *
 * 4. THE NEGATIVE CONTROL FOR THE TABLE ITSELF. A probe that only ever
 *    says OK is not evidence. `--self-test` deliberately corrupts the table
 *    (moves a command into the wrong group and changes its importer cell)
 *    and asserts that the checks then FAIL. If a corrupted table still
 *    passes, the probe is broken and says so.
 *
 * WHY BEHAVIOURAL RATHER THAN BYTE-CODE: the byte-code inventory (the
 * `Yaml*Command` classes in maestro-orchestra.jar) is a second, independent
 * source, but it is derived from the same release. The behavioural check
 * asks the shipped parser, which is what a user actually hits.
 *
 * usage: node tools/ats606-probes/probe-maestro-compat.mjs [--md <file>] [--self-test]
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

const SELF_TEST = process.argv.includes('--self-test');

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

const failures = [];
function fail(msg) {
  console.log(`FAIL ${msg}`);
  failures.push(msg);
}
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
function checkSyntax(body, retryOnce = false) {
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
    // Maestro prints NOTHING when it cannot run -- a JVM that died of
    // "insufficient memory for the Java Runtime Environment" leaves no
    // output and no "Invalid Command". Reading that as "the command is
    // valid" would turn a crashed run into a clean inventory, so an empty
    // output is a FAILURE, never an acceptance.
    if (out === '') {
      // The JVM can die of memory pressure when the host is busy. One
      // retry separates "this command is genuinely silent" from "the
      // machine was momentarily out of memory".
      if (retryOnce) {
        retryOnce = false;
        return checkSyntax(body, true);
      }
      fail(`the Maestro CLI produced no output for a command check (exit ${res.status}) -- the inventory is NOT verified`);
      return { accepted: false, output: '(no output)', status: res.status };
    }
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

console.log('=== ATS-606: the Maestro command inventory (behavioural) ===');
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
/* 2. The platform's REAL import behaviour, per command                */
/* ------------------------------------------------------------------ */

const { parseFlow } = await import(new URL('../../server/discovery/mobile-flow.mjs', import.meta.url).href);
const { importFlow, buildImportReport, STEP_ARGUMENTS } = await import(
  new URL('../../server/discovery/mobile-import.mjs', import.meta.url).href,
);

console.log('');
console.log('--- the platform importer, run over every fixture ---');

/** The measured behaviour of the importer for one command. */
const behaviour = {};
for (const [name, body] of Object.entries(fixtures.commands)) {
  const text = `${HEADER}${body}\n`;
  const flow = parseFlow(text, { syntax: 'maestro' });
  const imported = importFlow(flow, { file: `flows/${name}.yaml`, projectUid: 'p1' });
  const report = buildImportReport(imported);
  const kinds = [...new Set((imported.cases ?? []).flatMap((c) => c.steps.map((s) => s.kind)))];
  const reasons = Object.keys(report.unsupportedByReason ?? {});
  behaviour[name] = {
    mapped: report.mappedSteps > 0,
    kinds,
    reasons,
    /** The cell the table must state for this command. */
    cell: report.mappedSteps > 0
      ? `映射成功 → \`${kinds.join('`/`')}\``
      : `进导入报告：\`${reasons.join('+')}\``,
  };
}

const measuredMapped = Object.values(behaviour).filter((b) => b.mapped).length;
const measuredReported = Object.keys(behaviour).length - measuredMapped;
console.log(`mapped=${measuredMapped} reported=${measuredReported} (measured by running the importer)`);

/* ------------------------------------------------------------------ */
/* 3. The compatibility table in docs/25 §8.5                           */
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

const section = md.slice(md.indexOf('## 8. iOS'), md.indexOf('## 9. 安全与信任边界'));
if (!section) fail('§8 of the design document is missing');

/**
 * The three verdict groups, by their heading.
 *
 * The heading order matters: "部分可映射" contains "可映射", so the
 * partial group must be tested FIRST or every partial row would be
 * counted as mappable.
 */
function groupOf(heading) {
  if (/部分可映射/.test(heading)) return 'partial';
  if (/可映射/.test(heading)) return 'mappable';
  return 'unmappable';
}

const verdicts = { mappable: [], partial: [], unmappable: [] };
const rowsByCommand = new Map();

const groupRe = /####\s+8\.5\.\d\s+(.+)/g;
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
  for (const line of g.body.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 6) continue;
    // | command | platform kind | importer behaviour | parameter | note |
    const name = /^`([A-Za-z][A-Za-z0-9]*)$/.exec(cells[1]);
    if (!name) continue;
    const command = name[1];
    verdicts[verdict].push(command);
    rowsByCommand.set(command, {
      verdict,
      kind: cells[2],
      importer: cells[3],
      parameter: cells[4],
    });
  }
}

const allVerdicts = [...verdicts.mappable, ...verdicts.partial, ...verdicts.unmappable];
const uniqVerdicts = [...new Set(allVerdicts)].sort();

console.log(`table: mappable=${verdicts.mappable.length} partial=${verdicts.partial.length} unmappable=${verdicts.unmappable.length}`);

// The table must not be EMPTY. A probe that finds no rows would otherwise
// report "every accepted command has a verdict" over an empty set -- a
// vacuous pass that looks exactly like a clean run.
if (rowsByCommand.size === 0) {
  fail('§8.5 contains NO parseable table rows -- the check would pass vacuously, so no verdict is reported');
  console.log('COMPATIBILITY TABLE: FAIL (the table could not be read)');
  process.exit(1);
}
if (rowsByCommand.size !== Object.keys(fixtures.commands).length) {
  fail(`the table holds ${rowsByCommand.size} rows but the inventory has ${Object.keys(fixtures.commands).length} commands -- some rows are unreadable`);
}

// The table must be the GENERATED table, byte for byte. The generator is
// what measures the importer behaviour and the parameters; a hand-edited
// row would silently become a claim nobody measured.
{
  const generator = path.join(HERE, 'gen-section-rows.mjs');
  const gen = spawnSync(process.execPath, [generator, REPO], { encoding: 'utf8', timeout: 300000 });
  if (gen.error || gen.status !== 0) {
    fail(`the row generator could not be run (${gen.error?.message ?? `exit ${gen.status}`}) -- the table is NOT verified against the measurement`);
  } else {
    // Only the §8.5 rows are compared: §8.4 has rows of its own that also
    // start with a backticked name (the step kinds and the capabilities).
    const s85 = md.slice(md.indexOf('### 8.5 '), md.indexOf('### 8.6 '));
    const isInventoryRow = (l) => {
      const m = /^\| `([A-Za-z][A-Za-z0-9]*)`/.exec(l);
      return m ? Object.prototype.hasOwnProperty.call(fixtures.commands, m[1]) : false;
    };
    const genSet = gen.stdout.split(/\r?\n/)
    const docSet = s85.split(/\r?\n/)
    const onlyGen = genSet.filter((l) => !docSet.includes(l));
    const onlyDoc = docSet.filter((l) => !genSet.includes(l));
    if (onlyGen.length || onlyDoc.length) {
      for (const l of onlyGen) fail(`the generator produces a row the document does not have: ${l.slice(0, 120)}`);
      for (const l of onlyDoc) fail(`the document has a row the generator does not produce (it was hand-edited): ${l.slice(0, 120)}`);
    } else {
      ok(`the §8.5 rows are exactly the generated rows (${docSet.length}) -- the table was not hand-edited`);
    }
  }
}

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
  ok('every rejected spelling is accounted for in §8.5');
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

// The counts must ALSO match the measurement -- this is the check that
// catches "the table says 7 are mappable while the importer maps 4".
const statedImport = /映射成功\s*(\d+)\s*条\s*\/\s*进导入报告\s*(\d+)\s*条/.exec(section);
if (!statedImport) {
  fail('§8.5 does not state the importer counts in the form "映射成功 N 条 / 进导入报告 N 条"');
} else {
  const s = Number(statedImport[1]);
  const r = Number(statedImport[2]);
  if (s !== measuredMapped || r !== measuredReported) {
    fail(`§8.5 states 映射成功 ${s} / 进导入报告 ${r}, but the importer really does 映射成功 ${measuredMapped} / 进导入报告 ${measuredReported}`);
  } else {
    ok(`the stated importer counts (${s}/${r}) match the measured behaviour`);
  }
}

// EVERY ROW must state the importer behaviour the importer really has.
// This is the cell-by-cell check of the table against the measurement.
const wrongImporter = [];
for (const [command, row] of rowsByCommand) {
  const b = behaviour[command];
  if (!b) continue;
  if (row.importer.replace(/\s+/g, '') !== b.cell.replace(/\s+/g, '')) {
    wrongImporter.push(`${command}: table says "${row.importer}", the importer does "${b.cell}"`);
  }
}
if (wrongImporter.length) {
  for (const w of wrongImporter) fail(w);
} else {
  ok(`every row states the importer behaviour the importer actually has (${rowsByCommand.size} rows)`);
}

// The parameter cell must match ATS-602's own argument table.
const paramProblems = [];
for (const [command, row] of rowsByCommand) {
  const kind = row.kind.replace(/`/g, '').split(' ')[0].split('+')[0].trim();
  const spec = STEP_ARGUMENTS[kind];
  if (!spec) continue;
  const inModel = new Set([
    spec.primary,
    ...(spec.required ?? []),
    ...(spec.requiredAny ?? []).flat(),
    ...(spec.optional ?? []),
    ...Object.values(spec.aliases ?? {}).flat(),
  ]);
  // The cell must mention every parameter that IS in the model, and must
  // not claim a parameter is outside the model when it is inside.
  for (const p of inModel) {
    if (row.parameter === '—') continue;
    if (!row.parameter.includes(p) && !row.parameter.includes('全部在模型内')) {
      paramProblems.push(`${command}: the cell does not mention the in-model parameter "${p}"`);
    }
  }
  // And the reverse: a parameter the cell calls "模型外" must really be outside.
  const outClaims = [...row.parameter.matchAll(/模型外[^：]*：([^（]+)/g)];
  for (const m of outClaims) {
    for (const p of m[1].split('/').map((x) => x.trim().replace(/`/g, ''))) {
      if (p && inModel.has(p)) {
        paramProblems.push(`${command}: the cell calls "${p}" outside the model, but STEP_ARGUMENTS has it`);
      }
    }
  }
}
if (paramProblems.length) {
  for (const p of paramProblems) fail(p);
} else {
  ok('every parameter cell matches STEP_ARGUMENTS');
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
  for (const command of verdicts.mappable) {
    const row = rowsByCommand.get(command);
    if (!row) continue;
    const target = row.kind.replace(/`/g, '').split(' ')[0].split('+')[0].trim();
    if (target === '' || target === '—') continue;
    if (!stepKinds.includes(target)) badTargets.push(`${command} -> ${target}`);
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

/* ------------------------------------------------------------------ */
/* 4. The negative control FOR THE TABLE ITSELF                        */
/* ------------------------------------------------------------------ */

if (SELF_TEST) {
  console.log('');
  console.log('--- self-test: a deliberately corrupted table MUST be rejected ---');

  // Take the document, move one command into the wrong group and change
  // its importer cell. The checks above must then fail.
  const victim = 'launchApp';
  const corrupted = md.replace(
    /\| `launchApp` \| ([^|]*)\| 映射成功[^|]*\|/,
    '| `launchApp` | `assertVisible` | 映射成功 → `assertVisible` |',
  );
  if (corrupted === md) {
    fail('the self-test could not corrupt the table -- the row format changed');
  } else {
    const tmp = path.join(os.tmpdir(), `ats606-corrupt-${process.pid}.md`);
    fs.writeFileSync(tmp, corrupted, 'utf8');
    const res = spawnSync(process.execPath, [path.join(HERE, 'probe-maestro-compat.mjs'), '--md', tmp], {
      encoding: 'utf8',
      timeout: 300000,
    });
    fs.rmSync(tmp, { force: true });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (res.status === 0) {
      fail('the self-test FAILED: a corrupted table still passed -- the probe cannot detect a wrong verdict');
    } else if (!/FAIL/.test(out)) {
      fail(`the self-test could not confirm WHY the corrupted table failed (exit ${res.status})`);
    } else {
      ok(`the self-test: a corrupted table was rejected (exit ${res.status})`);
      const why = out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 3);
      for (const l of why) console.log(`     ${l}`);
    }
  }
}

/* ------------------------------------------------------------------ */

console.log('');
if (failures.length) {
  console.log(`COMPATIBILITY TABLE: FAIL (${failures.length} problem(s))`);
  process.exit(1);
}
console.log('COMPATIBILITY TABLE: OK');
if (SELF_TEST) console.log('SELF-TEST: OK');
console.log(`MAESTRO COMMAND INVENTORY: OK (${accepted.length} commands)`);
process.exit(0);
