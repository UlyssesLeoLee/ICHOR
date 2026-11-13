/**
 * ATS-606: the ACTION model -- what each Maestro command DOES, read out of
 * the shipped byte-code.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * The §8.5 verdict groups are, by §8.3, a judgement about two things: can
 * the platform's model express the ACTION, and does the COMMAND FORM match.
 * The command form is a FACT about Maestro, and it is readable out of the
 * byte-code: every Maestro command compiles into exactly one orchestra
 * command class, and that class says what the command does.
 *
 * Until now the grouping was checked only by the invariant "a mappable row
 * names a step kind ATS-601 freezes, an unmappable row names none". That
 * invariant cannot see a row that SHOULD be mappable but is filed as
 * unmappable with a `—` -- the very defect the round-3 review found in
 * `extendedWaitUntil`.
 *
 * So the criterion becomes MECHANICAL:
 *
 *   1. the byte-code says which orchestra command class each Maestro
 *      command compiles to (this file measures that);
 *   2. a table of those classes says which PLATFORM step kind expresses
 *      that action (this file also holds that table);
 *   3. a row's group must AGREE with what (1) and (2) say.
 *
 * The human judgement is still there -- the table in (2) is authored -- but
 * it is now stated ONCE, next to the facts it is combined with, and a row
 * that contradicts it is caught by the probe. A row cannot silently
 * disagree with the criterion any more.
 *
 * THE MEASUREMENT
 * ---------------
 * `YamlFluentCommand._toCommands` is one long `if (field != null) { ... }`
 * chain: each branch reads one YAML field and compiles it into one
 * orchestra command. The branch boundaries are recovered from the byte-code
 * itself (a branch starts at a `getfield` whose next instruction is
 * `ifnull`), so the mapping is a measurement, not a hand-written list.
 *
 * TWO FACTS THE MEASUREMENT MUST DISTINGUISH
 * ------------------------------------------
 * `tapOn`, `doubleTapOn` and `longPressOn` all compile into
 * `TapOnElementCommand` -- the same class. They differ only in the
 * `TapRepeat` argument (1 tap / 2 taps / a long press), so the VARIANT is
 * read from that argument, and the variant is what makes double-tap and
 * long-press DIFFERENT ACTIONS rather than the same one.
 *
 * `assertVisible`, `assertNotVisible` and `extendedWaitUntil` all compile
 * into `AssertConditionCommand`. They differ in the CONDITION they build:
 * a selector to be visible, a selector to be NOT visible, or a selector
 * plus a timeout. The condition's SHAPE is read out of the byte-code too.
 *
 * usage: node tools/ats606-probes/maestro-action-model.mjs [--json]
 * exit:  0 the model was derived, 1 it could not be derived (a skip is
 *        never a pass), 2 the Maestro jars are not installed
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Maestro installation whose jars hold the command classes.
 *
 * Without it the action model cannot be produced. A missing Maestro is a
 * SKIP (exit 2), never a "no action" claim.
 */
export function findMaestroLib() {
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

const JAVAP = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'javap') : 'javap';

/**
 * Splits `javap -c` output into method blocks.
 *
 * A METHOD header is a line at 2-space indent that ends with ');' and is
 * followed by a 'Code:' line. Field declarations end with ';' but are NOT
 * followed by 'Code:' -- matching on the ');' alone attributes a field's
 * bytes to the previous method, which silently moves every verdict.
 *
 * The lines are stripped of their line ending FIRST: `javap` on Windows
 * emits CRLF, and a check for the exact string 'Code:' then never matches
 * (the line is 'Code:\r'), which makes the parser find zero methods.
 */
function parseMethods(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  let cur = null;
  let body = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const isHeader =
      /^ {2}\S/.test(l) && l.trimEnd().endsWith(');') &&
      i + 1 < lines.length && lines[i + 1].trim() === 'Code:';
    if (isHeader) {
      const m = /^ {2}.*?([\w$-]+)\(.*\);$/.exec(l);
      if (m) {
        if (cur !== null) out[cur] = body.join('\n');
        cur = m[1];
        body = [l];
        continue;
      }
    }
    if (cur !== null) body.push(l);
  }
  if (cur !== null) out[cur] = body.join('\n');
  return out;
}

/** The orchestra command classes a branch body constructs. */
const COMMAND_CLASS = /new\s+#\d+\s+\/\/ class maestro\/orchestra\/([A-Z][A-Za-z0-9]*Command)/;
/** A call to another method of the same class (or of the orchestra). */
const CALL = /(?:invokestatic|invokespecial|invokevirtual)\s+#\d+\s+\/\/ Method ([A-Za-z0-9_$]+):/;
/** A read of one of the YAML fields. */
const FIELD = /getfield\s+#\d+\s+\/\/ Field ([A-Za-z0-9_$]+):/;

/**
 * The orchestra command class each Maestro command compiles to.
 *
 * MEASURED from `YamlFluentCommand._toCommands`.
 */
export function measureActions(lib = findMaestroLib()) {
  if (!lib) return null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ats606-action-'));
  try {
    execFileSync('jar', ['xf', path.join(lib, 'maestro-orchestra.jar'),
      'maestro/orchestra/yaml/YamlFluentCommand.class'], { cwd: work, timeout: 120000 });
    const file = path.join(work, 'maestro/orchestra/yaml/YamlFluentCommand.class');
    const text = execFileSync(JAVAP, ['-p', '-c', '-constants', file],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const methods = parseMethods(text);
    const toCommands = methods['_toCommands'];
    if (!toCommands) throw new Error('_toCommands was not found in YamlFluentCommand');

    const lines = toCommands.split('\n');
    // The branch boundaries: a branch READS one YAML field and tests it for
    // null. Recovering them from the byte-code is what makes the mapping a
    // measurement rather than a hand-written list.
    const starts = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = FIELD.exec(lines[i]);
      if (m && i + 1 < lines.length && /ifnull/.test(lines[i + 1])) starts.push({ field: m[1], at: i });
    }

    const classesOf = (body) => {
      const out = [];
      for (const l of body.split('\n')) {
        const m = COMMAND_CLASS.exec(l);
        if (m && m[1] !== 'MaestroCommand' && !out.includes(m[1])) out.push(m[1]);
      }
      return out;
    };
    const callsOf = (body) => {
      const out = [];
      for (const l of body.split('\n')) { const m = CALL.exec(l); if (m) out.push(m[1]); }
      return out;
    };
    const resolve = (name, seen = new Set()) => {
      if (seen.has(name)) return [];
      seen.add(name);
      const b = methods[name];
      if (!b) return [];
      let out = classesOf(b);
      for (const h of callsOf(b)) out = out.concat(resolve(h, seen));
      return [...new Set(out)];
    };

    const actions = {};
    starts.forEach((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1].at : lines.length;
      const seg = lines.slice(s.at, end).join('\n');
      let classes = classesOf(seg);
      for (const h of callsOf(seg)) classes = [...new Set([...classes, ...resolve(h)])];
      // `runFlow`, `repeat` and `retry` compile into a command that HOLDS a
      // list of other commands -- their bodies legitimately mention every
      // command class. They are flow-control, not an action.
      if (['RunFlowCommand', 'RepeatCommand', 'RetryCommand'].includes(classes[0])) classes = [classes[0]];

      // The VARIANT is measured on the branch AND on the helpers it calls:
      // `extendedWaitUntil` builds its condition inside the `extendedWait`
      // helper, so the branch itself does not show the timeout.
      const variant = variantOf(seg, lines.slice(s.at, end), callsOf(seg), methods);

      actions[s.field] = { field: s.field, classes, variant };
    });

    // The NAVIGATION commands.
    //
    // `back`, `hideKeyboard`, `scroll`, `clearKeychain` and `pasteText` are
    // not fields of their own: one YAML field (`action:`) holds a STRING
    // that is matched against the `YamlNavigationAction` enum, and the
    // enum value decides which command is built. So their action is
    // readable from TWO pieces of the byte-code:
    //
    //   1. the enum's `yamlValue` (the spelling a Flow may use) and its
    //      ordinal (the switch's case index);
    //   2. the switch table in `_toCommands`, which maps the ordinal to
    //      the command class that case builds.
    for (const [yamlValue, cls] of Object.entries(navigationActions(lib, work))) {
      actions[yamlValue] = { field: yamlValue, classes: [cls], variant: null, via: 'navigation' };
    }

    return actions;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The navigation commands: the yaml spelling of each one and the command
 * class it compiles into.
 *
 * The spelling comes from the enum's `yamlValue` field (read out of the
 * enum's own static initialiser), and the command class comes from the
 * switch table in `_toCommands` (the case bodies, in ordinal order).
 */
function navigationActions(lib, work) {
  const out = {};
  const enumFile = path.join(work, 'maestro/orchestra/yaml/YamlNavigationAction.class');
  execFileSync('jar', ['xf', path.join(lib, 'maestro-orchestra.jar'),
    'maestro/orchestra/yaml/YamlNavigationAction.class'], { cwd: work, timeout: 120000 });
  if (!fs.existsSync(enumFile)) return out;
  const enumText = execFileSync(JAVAP, ['-p', '-c', '-constants', enumFile],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

  // The enum constants: each is built as
  //   new YamlNavigationAction; ldc "<Name>"; iconst_<ordinal>; ldc "<yamlValue>"
  // so the pair (name, yamlValue) is read out of the initialiser.
  const pairs = [];
  const init = enumText.split(/static \{\};/)[1] ?? '';
  const CONST = /ldc\s+#\d+\s+\/\/ String ([A-Za-z]+)\s*\n\s*\d+:\s*iconst_(\d+)\s*\n\s*\d+:\s*ldc\s+#\d+\s+\/\/ String ([A-Za-z]+)/g;
  let m;
  while ((m = CONST.exec(init)) !== null) {
    pairs.push({ name: m[1], ordinal: Number(m[2]), yamlValue: m[3] });
  }
  if (!pairs.length) return out;

  // The switch table: `tableswitch { // -1 to N` lists the case targets in
  // ordinal order. Each case body builds one command class.
  const fluentFile = path.join(work, 'maestro/orchestra/yaml/YamlFluentCommand.class');
  const fluentText = execFileSync(JAVAP, ['-p', '-c', '-constants', fluentFile],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const methods = parseMethods(fluentText);
  const lines = (methods['_toCommands'] ?? '').split('\n');
  const sw = lines.findIndex((l) => /tableswitch/.test(l));
  if (sw < 0) return out;

  // The case targets, in order. The first entry is the default (-1), then
  // the cases 0..N.
  const targets = [];
  for (let i = sw + 1; i < lines.length; i += 1) {
    const t = /^\s*(-?\d+):\s*(\d+)\s*$/.exec(lines[i]);
    if (!t) break;
    targets.push(Number(t[2]));
  }
  // `targets[0]` is the default; `targets[1 + ordinal]` is the case.
  for (const p of pairs) {
    const target = targets[1 + p.ordinal];
    if (target === undefined) continue;
    const body = lines.slice(target, target + 12).join('\n');
    const c = /new\s+#\d+\s+\/\/ class maestro\/orchestra\/([A-Z][A-Za-z0-9]*Command)/.exec(body);
    if (c) out[p.yamlValue] = c[1];
  }
  return out;
}

/**
 * The VARIANT of an action -- what makes two commands that compile into the
 * SAME command class different ACTIONS.
 *
 *   * a TAP / a DOUBLE TAP / a LONG PRESS: all three compile into
 *     `TapOnElementCommand`, and they differ in the `tapCommand$default`
 *     arguments -- the long-press flag and the `TapRepeat` count;
 *   * an assertion's SHAPE: `assertVisible` puts its selector in the FIRST
 *     selector slot of the `Condition`, `assertNotVisible` in the SECOND,
 *     and `extendedWaitUntil` in the first plus a timeout. The slot is read
 *     from the byte-code: the `Condition` constructor takes
 *     (Platform, ElementSelector, ElementSelector, String, String), and
 *     which slot the selector lands in is what the two assertions differ in.
 *   * an EXPRESSION assertion: the condition is built from a STRING
 *     (`YamlAssertTrue.getCondition`) rather than from a selector.
 *
 * Everything else has no variant.
 */
function variantOf(seg, segLines, helperCalls, methods) {
  // The helpers this branch calls, and their bodies. `extendedWaitUntil`
  // builds its condition inside the `extendedWait` helper, so the branch
  // itself does not show the timeout.
  const helperBodies = [];
  for (const h of helperCalls) {
    const b = methods[h];
    if (b) helperBodies.push(b);
  }
  const helperSeg = helperBodies.join('\n');
  const all = `${seg}\n${helperSeg}`;
  const allLines = [...segLines, ...helperSeg.split('\n')];

  // The condition of an assertion: a selector, or an expression?
  if (/YamlAssertTrue\.getCondition:/.test(all)) return 'expression';

  // The WAIT: `extendedWaitUntil` builds the very same
  // `AssertConditionCommand` as a plain assertion, and what makes it a WAIT
  // rather than an assertion is the TIMEOUT it passes to that command --
  // the command's second argument is a timeout string, while a plain
  // assertion passes a label there. The timeout is read out of the
  // byte-code, so the difference is measured rather than asserted.
  if (/YamlExtendedWaitUntil\.getTimeout:/.test(all)) return 'extended-wait';

  // The tap variant: the boolean argument of tapCommand$default.
  const ti = allLines.findIndex((l) => /tapCommand\$default/.test(l));
  if (ti >= 0) {
    // The long-press flag is the boolean argument of tapCommand$default;
    // it is pushed as `iconst_1` for a long press and `iconst_0` for a
    // plain tap. The double tap is a `TapRepeat` with the count 2.
    //
    // The byte-code lines carry an instruction OFFSET ("88: iconst_1"), so
    // the comparison is on the instruction, not on the whole line.
    const pre = allLines.slice(Math.max(0, ti - 8), ti)
      .map((x) => x.replace(/^\s*\d+:\s*/, '').trim());
    if (pre.includes('iconst_1')) return 'long-press';
    if (/TapRepeat\."<init>":\(I/.test(all)) return 'double-tap';
    return 'tap';
  }

  // The assertion shape: which Condition slot does the selector go into?
  //
  // The Condition constructor is
  //   (Platform, ElementSelector visible, ElementSelector notVisible,
  //    String scriptCondition, String label)
  // so a selector pushed as the FIRST slot argument is a "visible"
  // condition and one pushed as the SECOND is a "not visible" condition.
  const ci = allLines.findIndex((l) => /Method maestro\/orchestra\/Condition\."<init>"/.test(l));
  if (ci >= 0) {
    const window = allLines.slice(Math.max(0, ci - 14), ci);
    // The selector is built by `toElementSelector`; where it lands among
    // the constructor's arguments is what tells the two apart.
    const selAt = window.findIndex((l) => /toElementSelector:/.test(l));
    if (selAt >= 0) {
      // Count the `aconst_null` placeholders BEFORE the selector: the
      // first slot is filled by `aconst_null` (the platform), so a
      // selector preceded by one `aconst_null` lands in the SECOND slot.
      const before = window.slice(0, selAt).filter((l) => /aconst_null/.test(l)).length;
      if (before >= 2) return 'notVisible';
      return 'visible';
    }
    return 'expression';
  }

  return null;
}

/**
 * The PLATFORM step kind that expresses each orchestra action.
 *
 * This is the ONE place the human judgement lives: the byte-code says what
 * a Maestro command DOES, and this table says which of the platform's six
 * step kinds does the same thing. It is authored, and it is small, and it
 * is next to the facts it is combined with.
 *
 * The key is the orchestra command class; the value may be keyed by the
 * VARIANT when the variant changes the action. The value is:
 *
 *   { kind }        the platform step kind that expresses it -- ONE step
 *                  for one step, so the command form matches;
 *   { kind, form }  the platform CAN express the action, but the command
 *                  FORM differs (Maestro's paired start/stop commands
 *                  against the platform's single-step model) -- the
 *                  "partially mappable" case;
 *   null           the platform's model has no such action.
 */
export const ACTION_PLATFORM = Object.freeze({
  LaunchAppCommand: Object.freeze({ kind: 'launchApp' }),
  TapOnElementCommand: Object.freeze({
    'tap': Object.freeze({ kind: 'tapOn' }),
    'double-tap': null,          // a double tap is a DIFFERENT action
    'long-press': null,          // a long press is a DIFFERENT action
  }),
  TapOnPointV2Command: Object.freeze({ kind: 'tapOn' }),
  AssertConditionCommand: Object.freeze({
    'expression': null,          // an arbitrary expression is not a visibility assertion
    'visible': Object.freeze({ kind: 'assertVisible' }),
    'notVisible': Object.freeze({ kind: 'assertVisible', qualifier: 'notVisible' }),
    'extended-wait': Object.freeze({ kind: 'assertVisible' }),
  }),
  TakeScreenshotCommand: Object.freeze({ kind: 'takeScreenshot' }),
  StartRecordingCommand: Object.freeze({ kind: 'recordScreen', form: 'paired' }),
  StopRecordingCommand: Object.freeze({ kind: 'recordScreen', form: 'paired' }),
  ClearStateCommand: null,
  KillAppCommand: null,
  StopAppCommand: null,
  SetPermissionsCommand: null,
  SetLocationCommand: null,
  SetOrientationCommand: null,
  OpenLinkCommand: null,
  PressKeyCommand: null,
  EraseTextCommand: null,
  HideKeyboardCommand: null,
  PasteTextCommand: null,
  SetClipboardCommand: null,
  BackPressCommand: null,
  ScrollCommand: null,
  SwipeCommand: null,
  CopyTextFromCommand: null,
  ScrollUntilVisibleCommand: null,
  InputTextCommand: null,
  InputRandomCommand: null,
  RunScriptCommand: null,
  EvalScriptCommand: null,
  WaitForAnimationToEndCommand: null,
  TravelCommand: null,
  AddMediaCommand: null,
  SetAirplaneModeCommand: null,
  ToggleAirplaneModeCommand: null,
  SetDarkModeCommand: null,
  ToggleDarkModeCommand: null,
  AssertDarkModeCommand: null,
  AssertLightModeCommand: null,
  AssertScreenshotCommand: null,
  AssertWithAICommand: null,
  AssertNoDefectsWithAICommand: null,
  ExtractTextWithAICommand: null,
  ClearKeychainCommand: null,
  RunFlowCommand: null,
  RepeatCommand: null,
  RetryCommand: null,
});

/**
 * The verdict a measured action implies.
 *
 * The three verdicts are §8.3's, and they are derived from ONE rule:
 *
 *   不映射        the platform's model has no such action;
 *   部分可映射    the platform CAN express the action, but the command
 *                 FORM differs -- the platform's model is a SINGLE step
 *                 where Maestro's is a PAIR of commands;
 *   可映射        the platform's model expresses the action in ONE step
 *                 for one step.
 *
 * So the verdict is a function of (the action the byte-code says, the
 * platform table above) -- and the qualifier the platform needs to express
 * the action is part of the answer.
 *
 * @returns {{verdict: '可映射'|'部分可映射'|'不映射', kind: string|null,
 *            qualifier: string|null, form: string|null}}
 */
export function verdictOf(action) {
  const cls = action.classes[0];
  if (!cls) return { verdict: '不映射', kind: null, qualifier: null, form: null };
  const entry = ACTION_PLATFORM[cls];
  if (entry === undefined) {
    // An action the table does not know about is NOT silently treated as
    // unmappable: that would be a guess. The caller must fail.
    throw new Error(`the action model has no entry for the command class "${cls}"`);
  }
  const resolved = (entry !== null && typeof entry === 'object' && action.variant && entry[action.variant] !== undefined)
    ? entry[action.variant]
    : entry;
  if (!resolved) return { verdict: '不映射', kind: null, qualifier: null, form: null };
  if (resolved.form === 'paired') {
    return { verdict: '部分可映射', kind: resolved.kind, qualifier: null, form: 'paired' };
  }
  return { verdict: '可映射', kind: resolved.kind, qualifier: resolved.qualifier ?? null, form: null };
}

/* ------------------------------------------------------------------ */
/* Running this file on its own                                        */
/* ------------------------------------------------------------------ */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lib = findMaestroLib();
  if (!lib) {
    console.log('SKIP no Maestro installation found (the action model needs its byte-code).');
    console.log('     Set ATS606_MAESTRO_HOME to the Maestro directory.');
    process.exit(2);
  }
  const actions = measureActions(lib);
  if (!actions) {
    console.log('FAIL the action model could not be derived');
    process.exit(1);
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(actions, null, 2));
  } else {
    console.log(`=== ATS-606: the Maestro action model (measured from the byte-code) ===`);
    console.log(`lib   : ${lib}`);
    console.log(`fields: ${Object.keys(actions).length}`);
    console.log('');
    for (const [field, a] of Object.entries(actions)) {
      console.log(`${field.padEnd(26)} ${a.classes.join(',') || '-'}  ${a.variant ?? ''}`);
    }
  }
  process.exit(0);
}
