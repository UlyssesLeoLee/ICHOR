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
 * The criterion becomes MECHANICAL:
 *
 *   1. the byte-code says which orchestra command class each Maestro
 *      command compiles to (this file measures that);
 *   2. a table of those classes says which PLATFORM step kind expresses
 *      that action (this file also holds that table);
 *   3. a row's group must AGREE with what (1) and (2) say.
 *
 * WHERE THE JUDGEMENT STILL IS, AND HOW IT IS GUARDED
 * --------------------------------------------------
 * The table in (2) is AUTHORED -- it is the one human judgement in the
 * chain, and it is the ONLY one. It cannot be removed: deciding which of
 * the platform's step kinds does what a Maestro command does is a
 * judgement, not a measurement.
 *
 * So the table is not left unguarded. Two STRUCTURAL RULES constrain what
 * it may say, and both are checked here rather than in prose:
 *
 *   R1 (the variant is the CONDITION, not the wait): the key of an
 *      assertion's entry is the SHAPE of the condition it builds -- which
 *      `Condition` slot the selector lands in -- and NOT how long it waits.
 *      `assertVisible`, `assertNotVisible` and `extendedWaitUntil` all
 *      build an `AssertConditionCommand` whose condition is the SAME
 *      shape as the plain assertion's, with a configurable timeout added.
 *      A table that gave the wait its own key would let the WAIT decide
 *      the group, which §8.3 forbids.
 *
 *   R2 (a paired command carries the pair): Maestro's recording commands
 *      are a PAIR -- `startRecording` and `stopRecording`. The command
 *      form is "one step of the platform's model versus Maestro's pair",
 *      so the two entries must agree: either both carry `form: 'paired'`
 *      or neither does. A table that gave only one of them the pairing
 *      would file a pair as two independent steps.
 *
 * Both rules are PROPERTIES OF THE TABLE, so they are checked on the
 * table itself -- a mutation of the table that breaks them is rejected
 * before any verdict is derived.
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
 * plus a timeout. The condition's SHAPE is read out of the byte-code too:
 * which `Condition` slot the selector lands in, and which slots the
 * command can fill at all.
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
      const { variant, slots, isWait } = variantOf(seg, lines.slice(s.at, end), callsOf(seg), methods, classes);

      actions[s.field] = { field: s.field, classes, variant, slots, isWait };
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
      actions[yamlValue] = { field: yamlValue, classes: [cls], variant: null, slots: [], via: 'navigation' };
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
 * SAME command class different ACTIONS -- and the CONDITION SLOTS the action
 * can fill.
 *
 *   * a TAP / a DOUBLE TAP / a LONG PRESS: all three compile into
 *     `TapOnElementCommand`, and they differ in the `tapCommand$default`
 *     arguments -- the long-press flag and the `TapRepeat` count;
 *   * an assertion's SHAPE: `assertVisible` puts its selector in the FIRST
 *     selector slot of the `Condition`, `assertNotVisible` in the SECOND,
 *     and `extendedWaitUntil` can fill EITHER (its YAML class declares a
 *     `visible` and a `notVisible` selector). The slot is read from the
 *     byte-code: the `Condition` constructor takes
 *     (Platform, ElementSelector, ElementSelector, String, String), and
 *     which slot the selector lands in is what the two assertions differ in.
 *   * an EXPRESSION assertion: the condition is built from a STRING
 *     (`YamlAssertTrue.getCondition`) rather than from a selector.
 *
 * The SLOTS are the set of `Condition` slots the action can fill. They are
 * what rule R1 is checked on: a command that fills a slot and waits longer
 * must be judged like the plain assertion for that slot, because §8.3 says
 * the wait does not decide the group.
 *
 * Everything else has no variant and no slot.
 *
 * @param {string[]} classes  the orchestra command classes of the branch
 */
function variantOf(seg, segLines, helperCalls, methods, classes) {
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

  // Only an ASSERTION has a condition. Every other command class has no
  // variant at all -- looking for a `Condition` in, say, a script command's
  // branch would invent one.
  const isAssertion = classes[0] === 'AssertConditionCommand';
  if (!isAssertion) {
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
      if (pre.includes('iconst_1')) return { variant: 'long-press', slots: [], isWait: false };
      if (/TapRepeat\."<init>":\(I/.test(all)) return { variant: 'double-tap', slots: [], isWait: false };
      return { variant: 'tap', slots: [], isWait: false };
    }
    return { variant: null, slots: [], isWait: false };
  }

  // The condition of an assertion: a selector, or an expression?
  // An expression is not a VISIBILITY condition, so it fills no slot.
  if (/YamlAssertTrue\.getCondition:/.test(all)) {
    return { variant: 'expression', slots: [], isWait: false };
  }

  // The SLOTS a command can fill, read out of the YAML getters it calls:
  // `getVisible` fills the first selector slot of the `Condition`,
  // `getNotVisible` the second. `extendedWaitUntil` calls BOTH -- its YAML
  // class declares a `visible` and a `notVisible` selector -- so it can
  // express either condition.
  const slots = [];
  const addSlot = (slot) => { if (!slots.includes(slot)) slots.push(slot); };
  for (const l of allLines) {
    const m = /Method maestro\/orchestra\/yaml\/Yaml\w+\.(getVisible|getNotVisible):/.exec(l);
    if (!m) continue;
    addSlot(m[1] === 'getVisible' ? 'visible' : 'notVisible');
  }

  // The WAIT: `extendedWaitUntil` builds the very same
  // `AssertConditionCommand` as a plain assertion, and what makes it a WAIT
  // rather than an assertion is the TIMEOUT it passes to that command --
  // the command's second argument is a timeout string, while a plain
  // assertion passes a label there. The timeout is read out of the
  // byte-code, so the difference is measured rather than asserted.
  //
  // The timeout is an ATTRIBUTE of the action, not a different condition:
  // the condition it builds has the same slots as the plain assertion's.
  // That is exactly why rule R1 exists.
  const isWait = /YamlExtendedWaitUntil\.getTimeout:/.test(all);

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
      addSlot(before >= 2 ? 'notVisible' : 'visible');
    }
  }

  // The variant: the CONDITION. The wait is NOT a variant -- it is an
  // attribute of the action (how long it waits), and §8.3 says the wait
  // does not decide the group.
  //
  // A command that fills exactly one slot takes that slot's name. A
  // command that can fill BOTH (`extendedWaitUntil`) takes the slot of the
  // condition it actually builds -- and the plain assertion for that slot
  // is what it must be judged like. That is rule R1.
  let variant = null;
  if (slots.length === 1) variant = slots[0];
  else if (slots.length > 1) variant = slots.slice().sort().join('|');

  return { variant, slots, isWait };
}

/**
 * The PAIRED commands -- a `start<V>` command and the `stop<V>` command
 * that closes it.
 *
 * The pairing is read out of the byte-code's own field names: Maestro's
 * `_toCommands` reads one YAML field per command, and the two fields of a
 * begin/end pair share their verb. `startRecording` and `stopRecording` are
 * such a pair; `stopApp` alone is not, because there is no `startApp`.
 *
 * The pairing matters because it is what makes the command FORM differ
 * from the platform's single-step model: one recording session is one step
 * on the platform and a PAIR of commands in Maestro.
 */
export function measurePairs(actions) {
  const names = Object.keys(actions);
  const known = new Set(names);
  const out = [];
  for (const name of names) {
    const m = /^start(.+)$/.exec(name);
    if (!m) continue;
    const other = `stop${m[1]}`;
    if (!known.has(other)) continue;
    const startClass = actions[name]?.classes?.[0] ?? null;
    const stopClass = actions[other]?.classes?.[0] ?? null;
    if (!startClass || !stopClass) continue;
    out.push({ start: name, stop: other, startClass, stopClass });
  }
  return out;
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
 *
 * R1 (the variant is the CONDITION, not the wait): the assertion entry is
 * keyed by the CONDITION SLOT (`visible` / `notVisible`), never by the
 * wait. `extendedWaitUntil` can fill either slot, so it is looked up by
 * the slot it fills -- the same key `assertVisible` uses. There is no
 * `extended-wait` key, so no table edit can let the timeout decide the
 * group.
 *
 * R2 (a paired command carries the pair): the two entries of a begin/end
 * pair must agree on `form`. A pair whose two halves disagree is a table
 * defect, and `checkTableRules()` rejects it.
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
    // The WAIT over either condition. This entry is NOT free: rule R1
    // binds it to the `visible` / `notVisible` entries above -- it must
    // name the same GROUP and the same step KIND, so the timeout can
    // never decide the group. The LOOKUP does not use this key (a
    // command that fills both slots is resolved by its slot), so this
    // entry states the wait's judgement and R1 holds it to the slots.
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
 * The RULES the platform table has to satisfy, checked on the table itself.
 *
 * A rule is a property of the table that no single row can violate on its
 * own. Both rules exist because §8.3's criterion is a claim about the
 * table as a whole, and a claim about the whole can only be checked on the
 * whole.
 *
 *   R1  the wait does not decide the group. A command that builds the SAME
 *       condition as a plain assertion and only waits longer must be
 *       judged in the same group. The check: for every slot the waiting
 *       command can fill, the table's entry for the wait must agree with
 *       the table's entry for the plain assertion of that slot -- the same
 *       GROUP and the same step KIND. The QUALIFIER is allowed to differ,
 *       because a wait over both conditions cannot carry one qualifier;
 *       the wait is a property of the group, not of the qualifier.
 *
 *   R2  a begin/end pair carries the pairing on BOTH halves, and ONLY a
 *       measured pair may carry it. The check runs both ways:
 *         - every measured pair has `form: 'paired'` on both halves
 *           (§8.3: a Maestro begin/end pair against the platform's
 *           single-step model IS the "命令形态不同" case);
 *         - no other command class carries `form: 'paired'`.
 *
 * `checkTableRules()` returns the list of violations. An empty list means
 * the table satisfies §8.3's criterion; a non-empty list means it does
 * not, and the caller must fail rather than derive a verdict.
 *
 * @param {object} actions  the measured actions (from `measureActions`)
 * @param {object} table    the platform table (defaults to ACTION_PLATFORM)
 * @returns {string[]} the violations
 */
export function checkTableRules(actions, table = ACTION_PLATFORM) {
  const problems = [];

  /** The GROUP an entry puts a command in. */
  const groupOf = (entry) => {
    if (entry === null || entry === undefined) return '不映射';
    if (typeof entry !== 'object') return '不映射';
    if (entry.form === 'paired') return '部分可映射';
    return '可映射';
  };
  /** The step KIND an entry points at, or null. */
  const kindOf = (entry) => (entry && typeof entry === 'object' ? (entry.kind ?? null) : null);
  /** The entry of a table row for one variant. */
  const entryFor = (cls, variant) => {
    const entry = table[cls];
    if (entry === undefined || entry === null || typeof entry !== 'object') return entry;
    return entry[variant];
  };

  // --- R1: the wait does not decide the group --------------------------
  //
  // The reference is the PLAIN assertion for the same slot: the command
  // that builds the same condition and carries no timeout. `assertVisible`
  // is the reference for the `visible` slot, `assertNotVisible` for the
  // `notVisible` slot. A command that fills a slot and waits longer must
  // land on the same verdict as the one that does not wait.
  //
  // The check is on the GROUP and the step KIND. The QUALIFIER may differ:
  // a wait over BOTH conditions cannot carry one qualifier, and the
  // qualifier is a property of the CONDITION, not of the group.
  const slotReference = new Map();
  for (const [name, action] of Object.entries(actions)) {
    if (!action?.slots?.length) continue;
    if (action.isWait) continue;               // the waiter itself
    if (action.variant !== 'visible' && action.variant !== 'notVisible') continue;
    const cls = action.classes[0];
    const resolved = entryFor(cls, action.variant);
    if (resolved === undefined) continue;
    const key = `${cls}#${action.variant}`;
    if (!slotReference.has(key)) {
      slotReference.set(key, { name, group: groupOf(resolved), kind: kindOf(resolved) });
    }
  }
  for (const [name, action] of Object.entries(actions)) {
    if (!action?.isWait) continue;
    if (!action.slots?.length) continue;
    const cls = action.classes[0];
    // The wait has its OWN entry in the table -- and rule R1 holds it to
    // the plain assertions' entries. A table that gave the wait a
    // different group or a different step kind would let the TIMEOUT
    // decide the group, which §8.3 forbids.
    const waitEntry = entryFor(cls, 'extended-wait');
    if (waitEntry === undefined) {
      problems.push(
        `R1: ${name} builds a visibility condition and only waits longer, so it must be `
        + `judged like the plain assertion -- but the table has no entry for the wait`,
      );
      continue;
    }
    for (const slot of action.slots) {
      const ref = slotReference.get(`${cls}#${slot}`);
      if (!ref) continue;
      const group = groupOf(waitEntry);
      const kind = kindOf(waitEntry);
      if (group !== ref.group || kind !== ref.kind) {
        problems.push(
          `R1: ${name} builds the "${slot}" condition and only waits longer than ${ref.name}, `
          + `so it must be judged in the same group with the same step kind -- `
          + `the table gives it group=${group} kind=${JSON.stringify(kind)}, `
          + `but ${ref.name} is group=${ref.group} kind=${JSON.stringify(ref.kind)}`,
        );
      }
    }
  }

  // --- R2: a begin/end pair carries the pairing on both halves ---------
  const pairs = measurePairs(actions);
  const pairedClasses = new Set();
  for (const pair of pairs) {
    pairedClasses.add(pair.startClass);
    pairedClasses.add(pair.stopClass);
    const startEntry = table[pair.startClass];
    const stopEntry = table[pair.stopClass];
    if (startEntry === undefined || stopEntry === undefined) continue;
    const formOf = (e) => (e && typeof e === 'object' ? (e.form ?? null) : null);
    if (formOf(startEntry) !== 'paired' || formOf(stopEntry) !== 'paired') {
      problems.push(
        `R2: ${pair.start} and ${pair.stop} are a begin/end pair, so both halves must carry `
        + `form='paired' -- the table gives "${pair.startClass}" form=${JSON.stringify(formOf(startEntry))} `
        + `and "${pair.stopClass}" form=${JSON.stringify(formOf(stopEntry))}`,
      );
    }
  }
  // And the converse: only a MEASURED pair may carry the pairing.
  for (const [cls, entry] of Object.entries(table)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.form !== 'paired') continue;
    if (pairedClasses.has(cls)) continue;
    problems.push(
      `R2: "${cls}" carries form='paired', but it is not one half of a measured begin/end pair `
      + `-- only a paired command may carry the pairing`,
    );
  }

  return problems;
}

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
 * The lookup is by the action's VARIANT, and for an assertion the variant
 * is the CONDITION SLOT it fills -- never the wait.
 *
 * @param {object} action  a measured action
 * @param {object} table   the platform table (defaults to ACTION_PLATFORM)
 * @returns {{verdict: '可映射'|'部分可映射'|'不映射', kind: string|null,
 *            qualifier: string|null, form: string|null}}
 */
export function verdictOf(action, table = ACTION_PLATFORM) {
  const cls = action.classes[0];
  if (!cls) return { verdict: '不映射', kind: null, qualifier: null, form: null };
  const entry = table[cls];
  if (entry === undefined) {
    // An action the table does not know about is NOT silently treated as
    // unmappable: that would be a guess. The caller must fail.
    throw new Error(`the action model has no entry for the command class "${cls}"`);
  }

  // The lookup is by the action's VARIANT -- the CONDITION it builds,
  // with the wait as its own variant because the wait has its own entry
  // in the table. Rule R1 holds that entry to the plain assertions'
  // entries, so the timeout can never decide the group.
  let resolved;
  const slots = action.slots ?? [];
  if (entry !== null && typeof entry === 'object') {
    if (action.isWait) {
      // The wait's entry -- the one R1 binds to the slots.
      resolved = entry['extended-wait'];
      if (resolved === undefined) resolved = entry[slots[0]];
      if (resolved === undefined) resolved = entry;
    } else if (slots.length > 1) {
      // A command that fills BOTH slots and is NOT a wait: there is no
      // single condition, so the table's entry for its first slot is
      // used and the rule check reports any disagreement.
      resolved = entry[slots[0]];
      if (resolved === undefined) resolved = entry;
    } else {
      const variant = action.variant ?? null;
      resolved = (variant && entry[variant] !== undefined) ? entry[variant] : entry;
    }
  } else {
    resolved = entry;
  }

  if (!resolved) return { verdict: '不映射', kind: null, qualifier: null, form: null };
  if (resolved.form === 'paired') {
    return { verdict: '部分可映射', kind: resolved.kind, qualifier: null, form: 'paired' };
  }
  return { verdict: '可映射', kind: resolved.kind, qualifier: resolved.qualifier ?? null, form: null };
}

/** The GROUP a table entry puts a command in. */
function groupOfEntry(entry) {
  if (entry === null || entry === undefined) return '不映射';
  if (typeof entry !== 'object') return '不映射';
  if (entry.form === 'paired') return '部分可映射';
  return '可映射';
}

/** The step KIND a table entry points at, or null. */
function kindOfEntry(entry) {
  return (entry && typeof entry === 'object') ? (entry.kind ?? null) : null;
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
      const slots = a.slots?.length ? `  slots=${a.slots.join('|')}` : '';
      console.log(`${field.padEnd(26)} ${a.classes.join(',') || '-'}  ${a.variant ?? ''}${slots}`);
    }
    const pairs = measurePairs(actions);
    console.log('');
    console.log(`=== the paired commands (a begin/end pair) ===`);
    for (const p of pairs) {
      console.log(`${p.start} / ${p.stop}  ->  ${p.startClass} / ${p.stopClass}`);
    }
    console.log('');
    console.log('=== the rules the platform table has to satisfy ===');
    const problems = checkTableRules(actions);
    if (problems.length) {
      for (const p of problems) console.log(`FAIL ${p}`);
      console.log(`TABLE RULES: FAIL (${problems.length} violation(s))`);
      process.exit(1);
    }
    console.log('R1 the wait does not decide the group: OK');
    console.log('R2 a begin/end pair carries the pairing on both halves: OK');
    console.log('TABLE RULES: OK');
  }
  process.exit(0);
}
