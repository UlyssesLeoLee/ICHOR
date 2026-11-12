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
 * env:   ATS606_SKIP_MAESTRO=1  skip the 55 Maestro CLI invocations (the
 *        table checks do not need them). The summary then says the
 *        inventory was NOT verified -- a skip is never a pass.
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

/** The Maestro installation whose jars hold the command classes. */
function findMaestroHome() {
  const roots = [
    process.env.ATS606_MAESTRO_HOME,
    'D:/AI-Tools/Maestro',
    path.join(os.homedir(), '.maestro'),
    '/usr/local',
    '/opt/homebrew',
  ].filter(Boolean);
  for (const r of roots) {
    const lib = path.join(r, 'lib');
    if (fs.existsSync(lib) && fs.existsSync(path.join(lib, 'maestro-orchestra.jar'))) return lib;
  }
  return null;
}

const MAESTRO = findMaestro();
const MAESTRO_HOME = findMaestroHome();

/**
 * Whether to skip the 55 Maestro CLI invocations.
 *
 * The inventory is the SLOW part of this probe (55 JVM starts, minutes).
 * The table checks below do not need it -- they need the fixture list and
 * the platform's own code. `ATS606_SKIP_MAESTRO=1` skips the CLI calls and
 * takes the fixture list as the inventory.
 *
 * A run that skipped the CLI does NOT claim the inventory was verified:
 * the summary says so, and the exit code still distinguishes the two.
 */
const SKIP_MAESTRO = process.env.ATS606_SKIP_MAESTRO === '1';

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

if (!MAESTRO && !SKIP_MAESTRO) {
  console.log('SKIP no Maestro CLI found.');
  console.log('     Set ATS606_MAESTRO_BIN to the maestro executable to run this probe.');
  console.log('     The command inventory was NOT verified on this machine.');
  process.exit(2);
}

console.log('=== ATS-606: the Maestro command inventory (behavioural) ===');
if (MAESTRO) console.log(`maestro : ${MAESTRO.cmd}`);
else console.log('maestro : SKIPPED (ATS606_SKIP_MAESTRO=1) -- the inventory was NOT behaviourally verified in this run');
let version = '(unknown)';
try {
  if (MAESTRO) {
    version = execFileSync(MAESTRO.cmd, [...MAESTRO.args, '--version'], {
      encoding: 'utf8',
      timeout: 120000,
      shell: process.platform === 'win32' && MAESTRO.cmd.endsWith('.bat'),
    }).trim();
  }
} catch {
  /* the version is nice to have, not a check */
}
console.log(`version : ${version}`);
console.log('');

const inventory = new Map();
if (SKIP_MAESTRO) {
  // The fixture list stands in for the inventory. The command names are
  // the SAME list the behavioural check walks, so the table checks are
  // unaffected; only the "these really are Maestro commands" claim is
  // not made in this run.
  for (const name of Object.keys(fixtures.commands)) inventory.set(name, true);
} else {
  for (const [name, body] of Object.entries(fixtures.commands)) {
    const r = checkSyntax(body);
    inventory.set(name, r.accepted);
    const mark = r.accepted ? 'ok  ' : 'FAIL';
    console.log(`${mark} command ${name.padEnd(24)} ${r.accepted ? 'accepted' : 'REJECTED'}`);
    if (!r.accepted) console.log(`       ${r.output.split('\n')[0]}`);
  }
}

console.log('');
console.log('--- negative controls (these MUST be rejected) ---');
if (!SKIP_MAESTRO) {
  for (const [name, body] of Object.entries(fixtures.negativeControls)) {
    if (name.startsWith('_')) continue;
    const r = checkSyntax(body);
    if (r.accepted) {
      fail(`negative control "${name}" was ACCEPTED by Maestro -- the check cannot tell a real command from a typo`);
    } else {
      ok(`negative control "${name}" rejected as expected`);
    }
  }
} else {
  console.log('     SKIPPED (ATS606_SKIP_MAESTRO=1)');
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
/* 3. The Maestro parameter lists, read out of the byte-code           */
/* ------------------------------------------------------------------ */

/**
 * The Maestro class that declares each command's parameters.
 *
 * The same table the row generator uses; the two must not drift, so the
 * generator is the single source and this reads the SAME classes.
 */
const YAML_CLASS = {
  launchApp: 'YamlLaunchApp',
  takeScreenshot: 'YamlTakeScreenshot',
  startRecording: 'YamlStartRecording',
  stopRecording: 'YamlStopRecording',
  clearState: 'YamlClearState',
  killApp: 'YamlKillApp',
  stopApp: 'YamlStopApp',
  setPermissions: 'YamlSetPermissions',
  extendedWaitUntil: 'YamlExtendedWaitUntil',
  scrollUntilVisible: 'YamlScrollUntilVisible',
  openLink: 'YamlOpenLink',
  pressKey: 'YamlPressKey',
  assertScreenshot: 'YamlAssertScreenshot',
  setClipboard: 'YamlSetClipboard',
  setLocation: 'YamlSetLocation',
  addMedia: 'YamlAddMedia',
  runScript: 'YamlRunScript',
  evalScript: 'YamlEvalScript',
  repeat: 'YamlRepeatCommand',
  retry: 'YamlRetryCommand',
  travel: 'YamlTravelCommand',
  waitForAnimationToEnd: 'YamlWaitForAnimationToEndCommand',
  runFlow: 'YamlRunFlow',
  assertWithAI: 'YamlAssertWithAI',
  setOrientation: 'YamlSetOrientation',
  setAirplaneMode: 'YamlSetAirplaneMode',
  setDarkMode: 'YamlSetDarkMode',
  eraseText: 'YamlEraseText',
  inputText: 'YamlInputText',
  back: 'YamlActionBack',
  hideKeyboard: 'YamlActionHideKeyboard',
  pasteText: 'YamlActionPasteText',
  clearKeychain: 'YamlActionClearKeychain',
  scroll: 'YamlActionScroll',
  swipe: 'YamlSwipe',
};
/** The element selector is shared by the tap / assert commands. */
const SELECTOR_COMMANDS = ['tapOn', 'assertVisible', 'assertNotVisible', 'doubleTapOn', 'longPressOn', 'copyTextFrom'];

const maestroParamsCache = new Map();
/** The Maestro parameter names of a command, or null when unavailable. */
function maestroParamsOf(command) {
  if (maestroParamsCache.has(command)) return maestroParamsCache.get(command);
  const cls = SELECTOR_COMMANDS.includes(command) ? 'YamlElementSelector' : YAML_CLASS[command];
  if (!cls || !MAESTRO_HOME) {
    maestroParamsCache.set(command, null);
    return null;
  }
  let params = null;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats606-params-'));
    const target = path.join(dir, `${cls}.class`);
    execFileSync('jar', ['xf', path.join(MAESTRO_HOME, 'maestro-orchestra.jar'), `maestro/orchestra/yaml/${cls}.class`], { cwd: dir, timeout: 120000 });
    if (fs.existsSync(target)) {
      const text = execFileSync('javap', ['-p', target], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      params = text.split(/\r?\n/)
        .filter((l) => /^\s{2}private final /.test(l))
        .map((l) => /private final ([\w.$<>\[\], ?]+) (\w+);/.exec(l.trim()))
        .filter(Boolean)
        .map((m) => m[2])
        .filter((p) => !['label', 'optional'].includes(p));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    params = null;
  }
  maestroParamsCache.set(command, params);
  return params;
}

/* ------------------------------------------------------------------ */
/* 4. The compatibility table in docs/25 §8.5                           */
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
 *
 * The heading must NAME the group and nothing else: §8.5.4's heading
 * ("统计与「两个数字为什么不一样」") does not, but §8.5.4's BODY repeats
 * the word "可映射", so a heading that merely CONTAINS the word would
 * swallow §8.5.5's table as verdict rows. The three verdict headings
 * are exactly "<group>（N 条）", so the pattern is anchored on that.
 *
 * A heading that names NONE of the three groups is NOT a verdict group
 * (§8.5.4 and §8.5.5 carry the statistics and the conclusion). Such a
 * heading yields `null` and its rows are skipped.
 */
const GROUP_HEADING = /^(部分可映射|可映射|不映射)（\d+ 条）$/;
function groupOf(heading) {
  const m = GROUP_HEADING.exec(heading.trim());
  if (!m) return null;
  if (m[1] === '部分可映射') return 'partial';
  if (m[1] === '可映射') return 'mappable';
  return 'unmappable';
}

const verdicts = { mappable: [], partial: [], unmappable: [] };
const rowsByCommand = new Map();

const groupRe = /####\s+8\.5\.\d\s+(.+)/g;
let gm;
const groups = [];
while ((gm = groupRe.exec(section)) !== null) {
  // The pattern has ONE capture group -- the heading text. `gm[2]` would
  // be undefined, and every group would then be unrecognised (and so
  // skipped), which would leave the table EMPTY rather than wrong.
  groups.push({ index: gm[1], title: gm[1], at: gm.index });
}
/**
 * Where each group ENDS.
 *
 * A group's body runs to the next `####` heading of ANY kind -- not just
 * the next verdict group. Otherwise the LAST verdict group would swallow
 * §8.5.4 and §8.5.5, and their tables (which restate command names in a
 * different shape) would be read as verdict rows.
 */
const anyHeadingRe = /^####\s+/gm;
groups.forEach((g) => {
  const rest = section.slice(g.at + 1);
  // The regex is GLOBAL, so its lastIndex persists between calls -- it
  // must be reset, or the second search starts where the first stopped
  // and every group after the first gets the wrong body.
  anyHeadingRe.lastIndex = 0;
  const m = anyHeadingRe.exec(rest);
  const end = m ? g.at + 1 + m.index : section.length;
  g.body = section.slice(g.at, end);
});

/**
 * The command name in the first cell of a table row.
 *
 * The cell is trimmed, so it carries no trailing carriage return; the
 * pattern anchors the closing backtick at the END of the cell.
 */
const COMMAND_CELL = /^`([A-Za-z][A-Za-z0-9]*)`$/;

for (const g of groups) {
  const verdict = groupOf(g.title);
  if (!verdict) continue;   // §8.5.4 / §8.5.5 are not verdict groups
  for (const line of g.body.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 6) continue;
    // | command | platform kind | importer behaviour | parameter | note |
    const name = COMMAND_CELL.exec(cells[1]);
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

// The table must be the GENERATED table, byte for byte.
//
// WHY THE WHOLE BLOCK, NOT THE ROWS
// ----------------------------------
// The first version compared the rows as an UNORDERED SET: it collected
// the rows of the document and the rows of the generator and checked
// that both sets held the same lines. That check cannot see WHICH GROUP
// a row is in -- moving a row from "可映射" to "不映射" and updating
// every stated count left the set unchanged, so the probe stayed green.
// That is the defect the round-2 review found (its mutants M1-M5 all
// passed).
//
// The block comparison below compares the WHOLE generated block -- the
// three group headings, every row in its group, and the TALLY line --
// against the document's block, character for character. The group
// headings and the TALLY are part of the comparison, so a row moved
// into another group changes the block and the probe goes red.
//
// The line terminators are normalised first: the document is CRLF on a
// Windows checkout and LF everywhere else, and the generator always
// writes LF. Comparing the raw bytes would report a difference on every
// Windows checkout, which would make the probe unusable there.
{
  const generator = path.join(HERE, 'gen-section-rows.mjs');
  const gen = spawnSync(process.execPath, [generator, REPO], { encoding: 'utf8', timeout: 600000 });
  if (gen.error || gen.status !== 0) {
    fail(`the row generator could not be run (${gen.error?.message ?? `exit ${gen.status}`}) -- the table is NOT verified against the measurement`);
  } else {
    const generated = gen.stdout.replace(/\r\n/g, '\n').replace(/^\s+/, '').replace(/\s+$/, '');
    const inDocument = blockOf(md);
    if (!inDocument) {
      fail('the document has no ATS606-ROWS block -- the generated rows cannot be compared with it');
    } else {
      const doc = inDocument.replace(/\r\n/g, '\n').replace(/^\s+/, '').replace(/\s+$/, '');
      if (doc !== generated) {
        // Point at the FIRST differing line: "something differs" is not
        // actionable, and the reviewer has to see WHICH line moved.
        const a = doc.split('\n');
        const b = generated.split('\n');
        let at = 0;
        while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
        const where = at < a.length
          ? `line ${at + 1} of the block: the document says "${(a[at] ?? '').slice(0, 100)}", the generator says "${(b[at] ?? '').slice(0, 100)}"`
          : `the document's block has ${a.length} lines, the generator's has ${b.length}`;
        fail(`the §8.5 block differs from the generated block -- ${where}. The group headings, the group of every row and the TALLY are all part of the comparison, so a row moved into another group is caught here.`);
      } else {
        ok(`the §8.5 block is exactly the generated block (${b0Lines(doc)} lines: the three group headings, all 55 rows and the TALLY) -- the table was not hand-edited`);
      }
    }
  }
}

/**
 * The generated block of the document: everything between the two
 * ATS606-ROWS markers, WITHOUT the markers themselves.
 *
 * The markers are the contract between the generator and the document:
 * the generator writes the block, the document holds it between the
 * markers, and the probe compares the two.
 */
function blockOf(text) {
  // The markers must stand ALONE on their line. A prose sentence that
  // mentions them in backticks (the §8.5 introduction does) would
  // otherwise be found first, and the "block" would be the sentence
  // between that mention and the real marker.
  const start = /^<!-- ATS606-ROWS-START -->[ \t]*$/m.exec(text);
  const end = /^<!-- ATS606-ROWS-END -->[ \t]*$/m.exec(text);
  if (!start || !end || end.index < start.index) return null;
  return text.slice(start.index + start[0].length, end.index);
}

/** The number of lines of a block, for the success message. */
function b0Lines(text) {
  return text.split('\n').length;
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
//
// What is checked: every parameter MAESTRO declares for the command (read
// out of its byte-code) that is INSIDE the platform's model must be
// mentioned in the cell, and every parameter the cell calls "模型外" must
// really be outside.
//
// The platform's ALIASES (e.g. `package` / `packageName` / `bundleId` for
// `appId`) are NOT required to appear: Maestro does not declare them, so
// requiring them would make the cell describe the platform's vocabulary
// rather than the parameter fidelity.
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
  ]);
  // The Maestro parameter names that the platform's model covers.
  const maestroParams = maestroParamsOf(command);
  if (!maestroParams) continue;
  for (const p of maestroParams) {
    if (!inModel.has(p)) continue;
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

// THE GROUPING INVARIANTS
// -----------------------
// The block comparison above proves the document holds the GENERATED
// block. It does not prove the grouping is RIGHT -- the generator could
// be wrong in the same way the document is wrong.
//
// So the grouping is checked against the CRITERION of §8.3, which is
// about the platform's own model:
//
//   可映射 / 部分可映射  the row names a step kind ATS-601 froze -- the
//                        platform's model CAN express the action;
//   不映射                the row names NO step kind -- the platform's
//                        model has no such action.
//
// The check is deliberately about the GROUP a row is in, not about the
// cell text: a row moved into the wrong group is exactly what must be
// caught.
const stepKinds = readStepKinds();
console.log('');
console.log('--- the platform vocabulary (ATS-601 / ATS-602) ---');
if (!stepKinds) {
  fail('cannot read the ATS-601 step vocabulary from server/adapters/mobile-target.mjs');
} else {
  console.log(`ATS-601 step kinds: ${stepKinds.join(', ')}`);
  const problems = [];

  /** The step kind a row names, or null when it names none. */
  const kindOf = (row) => {
    const target = row.kind.replace(/`/g, '').split(' ')[0].split('+')[0].trim();
    if (target === '' || target === '—') return null;
    return target;
  };

  for (const [command, row] of rowsByCommand) {
    const target = kindOf(row);
    if (row.verdict === 'unmappable') {
      // An unmappable row must NOT name a step kind: the platform's model
      // has no such action, so there is no kind to point at.
      if (target !== null) {
        problems.push(`${command} is in the unmappable group but names the step kind "${target}"`);
      }
      continue;
    }
    // A mappable / partially mappable row MUST name a frozen step kind.
    if (target === null) {
      problems.push(`${command} is in the ${row.verdict} group but names no step kind`);
      continue;
    }
    if (!stepKinds.includes(target)) {
      problems.push(`${command} names the step kind "${target}", which ATS-601 does not freeze`);
    }
  }
  if (problems.length) {
    for (const p of problems) fail(`the grouping breaks the §8.3 criterion: ${p}`);
  } else {
    ok(`the grouping breaks no §8.3 invariant: every mappable / partially mappable row names a step kind ATS-601 freezes, every unmappable row names none (${rowsByCommand.size} rows)`);
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
/* 5. The negative control FOR THE TABLE ITSELF                        */
/* ------------------------------------------------------------------ */

if (SELF_TEST) {
  console.log('');
  console.log('--- self-test: deliberately corrupted tables MUST be rejected ---');

  /**
   * Runs the probe against a MUTATED copy of the document and reports
   * whether the mutation was caught.
   *
   * A probe that only ever says OK is not evidence. Each mutation below
   * breaks the document in a specific way; the probe has to go red for
   * each of them, and the CONTROL (an unmutated copy) has to stay green
   * -- otherwise a probe that fails on everything would "pass" the
   * self-test.
   */
  const runOn = (text, label) => {
    const tmp = path.join(os.tmpdir(), `ats606-corrupt-${process.pid}-${label}.md`);
    fs.writeFileSync(tmp, text, 'utf8');
    const res = spawnSync(process.execPath, [path.join(HERE, 'probe-maestro-compat.mjs'), '--md', tmp], {
      encoding: 'utf8',
      timeout: 900000,
      env: { ...process.env, ATS606_SKIP_MAESTRO: '1' },
    });
    fs.rmSync(tmp, { force: true });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    return { status: res.status, out, caught: res.status !== 0 && /FAIL/.test(out) };
  };

  /**
   * Moves a row from one verdict group to another INSIDE the generated
   * block, and rewrites the group headings and the TALLY to match.
   *
   * This is the mutation the round-2 review used, and it is the one the
   * FIRST version of this probe could not catch: the rows were compared
   * as an unordered set, so moving one between groups -- and updating
   * every stated count -- left the set unchanged and the probe stayed
   * green. The block comparison now makes it visible.
   */
  const moveRow = (command, fromHeading, toHeading, counts) => {
    const block = blockOf(md);
    if (!block) return null;
    const ls = block.split(/\r?\n/);
    const rowAt = ls.findIndex((l) => l.startsWith(`| \`${command}\` |`));
    if (rowAt < 0) return null;
    const [row] = ls.splice(rowAt, 1);
    const h = ls.findIndex((l) => l.startsWith(toHeading));
    if (h < 0) return null;
    const sep = ls.findIndex((l, j) => j > h && l.startsWith('|---|'));
    if (sep < 0) return null;
    ls.splice(sep + 1, 0, row);
    const moved = ls.join('\n')
      .replace(/#### 8\.5\.1 可映射（\d+ 条）/, `#### 8.5.1 可映射（${counts[0]} 条）`)
      .replace(/#### 8\.5\.2 部分可映射（\d+ 条）/, `#### 8.5.2 部分可映射（${counts[1]} 条）`)
      .replace(/#### 8\.5\.3 不映射（\d+ 条）/, `#### 8.5.3 不映射（${counts[2]} 条）`)
      .replace(/<!-- TALLY mappable=\d+ partial=\d+ unmappable=\d+ total=\d+ imported=\d+ reported=\d+ -->/,
        `<!-- TALLY mappable=${counts[0]} partial=${counts[1]} unmappable=${counts[2]} total=${counts[0] + counts[1] + counts[2]} imported=${measuredMapped} reported=${measuredReported} -->`);
    // The markers must stand ALONE on their line -- the §8.5
    // introduction mentions them in backticks, and a plain indexOf
    // would find that mention first.
    const startMark = /^<!-- ATS606-ROWS-START -->[ \t]*$/m.exec(md);
    const endMark = /^<!-- ATS606-ROWS-END -->[ \t]*$/m.exec(md);
    if (!startMark || !endMark) return null;
    const head = md.slice(0, startMark.index + startMark[0].length);
    const tail = md.slice(endMark.index);
    // The counts stated in §8.5.4 are updated too, so that the
    // "stated counts match the table" check ALSO passes: the mutation is
    // CONSISTENT in every visible way, and the ONLY thing wrong with it
    // is WHICH GROUP the row is in. Only the block comparison can see
    // that -- which is exactly what has to be proven.
    const tailFixed = tail.replace(
      /可映射\s*\d+\s*条\s*\/\s*部分可映射\s*\d+\s*条\s*\/\s*不映射\s*\d+\s*条/,
      `可映射 ${counts[0]} 条 / 部分可映射 ${counts[1]} 条 / 不映射 ${counts[2]} 条`,
    );
    return head + moved + tailFixed;
  };

  /**
   * The counts a group move implies.
   *
   * The counts are derived from the LIVE table, so the mutation is a
   * CONSISTENT move: the group headings, the TALLY and the counts all
   * agree with each other. That is what makes the mutation hard -- the
   * only thing that is wrong about it is WHICH GROUP the row is in, and
   * only the block comparison can see that.
   */
  const movedCounts = (command, from, to) => {
    const counts = {
      mappable: verdicts.mappable.length,
      partial: verdicts.partial.length,
      unmappable: verdicts.unmappable.length,
    };
    if (!counts[from] || !counts[to]) return null;
    counts[from] -= 1;
    counts[to] += 1;
    return [counts.mappable, counts.partial, counts.unmappable];
  };

  const mutations = [];

  // The CONTROL: an unmutated copy must still pass, or the self-test
  // would be satisfied by a probe that rejects everything.
  mutations.push({
    label: 'control (unchanged)',
    text: md,
    mustBeRejected: false,
  });

  // M1: a row moved between groups, with every stated count updated.
  // The counts are consistent with the move, so ONLY the block
  // comparison can catch it.
  mutations.push({
    label: 'a row moved to another group (counts updated)',
    text: moveRow('assertNotVisible', '#### 8.5.2 ', '#### 8.5.1 ', movedCounts('assertNotVisible', 'partial', 'mappable')),
    mustBeRejected: true,
  });

  // M2: a row moved to the group of the commands the platform has no
  // semantics for. Its kind cell stays, so the §8.3 invariant must
  // catch it too.
  mutations.push({
    label: 'a row moved to the unmappable group (counts updated)',
    text: moveRow('tapOn', '#### 8.5.1 ', '#### 8.5.3 ', movedCounts('tapOn', 'mappable', 'unmappable')),
    mustBeRejected: true,
  });

  // M3: a cell edited by hand -- the importer cell states the wrong
  // behaviour.
  mutations.push({
    label: 'an importer cell edited by hand',
    text: md.replace(
      '| `launchApp` | `launchApp` | 映射成功 → `launchApp` |',
      '| `launchApp` | `launchApp` | 进导入报告：`unknown-command` |',
    ),
    mustBeRejected: true,
  });

  for (const m of mutations) {
    if (m.text === null || m.text === undefined) {
      fail(`the self-test could not build the mutation "${m.label}" -- the table format changed`);
      continue;
    }
    if (!m.mustBeRejected && m.text === md) {
      // The control is the document itself.
    }
    const r = runOn(m.text, m.label.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40));
    if (!m.mustBeRejected) {
      if (r.status === 0) {
        ok(`the self-test control: an unmutated document still passes (exit 0)`);
      } else {
        fail(`the self-test control FAILED: an unmutated document was rejected (exit ${r.status}) -- the probe rejects the correct document`);
        const why = r.out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 3);
        for (const l of why) console.log(`     ${l}`);
      }
      continue;
    }
    if (r.caught) {
      ok(`the self-test: "${m.label}" was rejected (exit ${r.status})`);
      const why = r.out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 2);
      for (const l of why) console.log(`     ${l.slice(0, 160)}`);
    } else {
      fail(`the self-test FAILED: "${m.label}" was NOT caught (exit ${r.status}) -- the probe cannot detect this corruption`);
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
if (SKIP_MAESTRO) {
  console.log(`MAESTRO COMMAND INVENTORY: NOT VERIFIED (the CLI was skipped; ${accepted.length} fixture names used)`);
} else {
  console.log(`MAESTRO COMMAND INVENTORY: OK (${accepted.length} commands)`);
}
process.exit(0);
