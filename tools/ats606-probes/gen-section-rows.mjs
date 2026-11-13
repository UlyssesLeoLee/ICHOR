/**
 * ATS-606: generates the §8.5 rows of docs/25-MOBILE-APP-TESTING.md.
 *
 * WHY A GENERATOR
 * ---------------
 * The §8.5 table has four columns that are FACTS, not opinions:
 *
 *   * "ATS-602 导入器对 Maestro 原拼写的实际处理" -- what the importer
 *     really does with the Maestro spelling. Measured by running the
 *     importer over every fixture.
 *   * "参数保真" -- which of Maestro's own parameters are inside the
 *     platform's model (ATS-602's `STEP_ARGUMENTS`) and which are not,
 *     AND what the importer really does with an out-of-model parameter.
 *     Maestro's parameter list is read out of the shipped byte-code
 *     (`Yaml*` classes of maestro-orchestra.jar); the importer's
 *     behaviour is measured by running it.
 *   * the counts at the end of the section.
 *   * the GROUP each row belongs to -- and THIS ONE IS NOT AUTHORED.
 *
 * Those must not be typed by hand: a hand-written table drifts from
 * the code the moment either changes, and that is exactly the failure the
 * reviewer caught in round 1 (the table claimed 7 mappable commands while
 * the importer maps 4) and again in round 2 (the "参数保真" column
 * claimed "保留原文并告警" for every out-of-model parameter, while the
 * importer really rejects a step whose selector carries ONLY out-of-model
 * parameters).
 *
 * THE GROUP IS DERIVED, NOT AUTHORED
 * ----------------------------------
 * The group used to be a judgement written in this file, and the probe
 * could only check the two invariants "a mappable row names a step kind
 * ATS-601 freezes" and "an unmappable row names none". A row that SHOULD
 * have been mappable but was filed as unmappable with a `—` passed every
 * one of those checks.
 *
 * So the group is now DERIVED from the byte-code:
 *
 *   1. `maestro-action-model.mjs` measures what each Maestro command
 *      DOES -- the orchestra command class it compiles into, and the
 *      variant that tells two commands of the same class apart;
 *   2. the action model says which of the platform's six step kinds
 *      expresses that action, and whether the command FORM matches;
 *   3. the verdict follows from those two.
 *
 * The judgement that remains -- which platform step kind does what Maestro
 * command does -- lives in ONE table (`ACTION_PLATFORM`), next to the
 * facts it is combined with. It cannot be quietly contradicted by a row.
 *
 * THE GROUPING IS CHECKED, NOT ASSUMED
 * ------------------------------------
 * The generator emits the WHOLE block -- the three group headings, every
 * row, and the TALLY line -- and the probe compares that block with the
 * document byte for byte. A row moved into another group therefore
 * changes the block and the probe goes red. On top of that the probe
 * re-derives every verdict FROM THE BYTE-CODE and compares it with the
 * document, so a grouping that is wrong in BOTH the generator and the
 * document is caught as well.
 *
 * The SEMANTIC verdict -- which platform step kind expresses a Maestro
 * command -- lives in ONE table (`ACTION_PLATFORM` of
 * `maestro-action-model.mjs`), next to the facts it is combined with.
 * The GROUP each row belongs to is DERIVED from that table and the
 * measured action, so a row cannot contradict it.
 *
 * The generated block is delimited in the design document by
 * `<!-- ATS606-ROWS-START -->` and `<!-- ATS606-ROWS-END -->`.
 *
 * usage: node tools/ats606-probes/gen-section-rows.mjs [repo]
 * exit:  0 rows generated, 1 a command has no authored note, 2 the
 *        Maestro jars are not available (a skip is never a pass)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.argv[2] ?? path.join(HERE, '..', '..'));

const { parseFlow } = await import(
  new URL('../../server/discovery/mobile-flow.mjs', import.meta.url).href,
);
const { importFlow, buildImportReport, STEP_ARGUMENTS } = await import(
  new URL('../../server/discovery/mobile-import.mjs', import.meta.url).href,
);
const { measureActions, verdictOf } = await import(
  new URL('./maestro-action-model.mjs', import.meta.url).href,
);

const FIXTURES = path.join(HERE, 'maestro-command-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));

/* ------------------------------------------------------------------ */
/* 1. the importer behaviour, per command (MEASURED)                   */
/* ------------------------------------------------------------------ */

const behaviour = {};
for (const [name, body] of Object.entries(fixtures.commands)) {
  const text = `appId: ${fixtures.appId}\n---\n${body}\n`;
  const flow = parseFlow(text, { syntax: 'maestro' });
  const imported = importFlow(flow, { file: `flows/${name}.yaml`, projectUid: 'p1' });
  const report = buildImportReport(imported);
  const kinds = [...new Set((imported.cases ?? []).flatMap((c) => c.steps.map((s) => s.kind)))];
  behaviour[name] = {
    mapped: report.mappedSteps > 0,
    kinds,
    reasons: Object.keys(report.unsupportedByReason ?? {}),
    warnings: report.warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 2. the parameters (MEASURED: Maestro's byte-code vs STEP_ARGUMENTS) */
/* ------------------------------------------------------------------ */

/**
 * The Maestro installation to read the byte-code from.
 *
 * Without it the parameter column cannot be produced. A missing Maestro is
 * a SKIP (exit 2), never a "no parameters" claim -- the same rule the
 * other probes follow.
 */
function findMaestroLib() {
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
const LIB = findMaestroLib();
if (!LIB) {
  console.log('SKIP no Maestro installation found (the parameter column needs its byte-code).');
  console.log('     Set ATS606_MAESTRO_HOME to the Maestro directory.');
  process.exit(2);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ats606-rows-'));
function extract(jar, entry) {
  const target = path.join(WORK, entry);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync('jar', ['xf', path.join(LIB, jar), entry], { cwd: WORK, timeout: 120000 });
  return target;
}
/**
 * The declared fields of a class -- Maestro's own parameter list.
 *
 * The TYPE matters as well as the name: the measurement below has to
 * write a value of the right shape for each parameter (a Boolean is
 * `true`, an element selector is a nested map, a list is `[]`), because
 * a value of the wrong shape would not exercise the importer at all.
 */
function fieldsOf(file) {
  const t = execFileSync('javap', ['-p', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return t.split(/\r?\n/)
    .filter((l) => /^\s{2}private final /.test(l))
    .map((l) => /private final ([\w.$<>[\], ?]+) (\w+);/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ type: m[1], name: m[2] }))
    .filter((f) => !['label', 'optional'].includes(f.name));
}

/** The Maestro class that declares each command's parameters. */
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

function maestroParams(command) {
  const cls = SELECTOR_COMMANDS.includes(command) ? 'YamlElementSelector' : YAML_CLASS[command];
  if (!cls) return null;
  try {
    return fieldsOf(extract('maestro-orchestra.jar', `maestro/orchestra/yaml/${cls}.class`));
  } catch {
    return null;
  }
}
/** The platform's own parameter names for a step kind. */
function modelParams(kind) {
  const spec = STEP_ARGUMENTS[kind];
  if (!spec) return null;
  return new Set([
    spec.primary,
    ...(spec.required ?? []),
    ...(spec.requiredAny ?? []).flat(),
    ...(spec.optional ?? []),
    ...Object.values(spec.aliases ?? {}).flat(),
  ]);
}
/**
 * The arguments that NAME THE TARGET of a step of this kind.
 *
 * A step has to name its target, otherwise it is not a step of this
 * kind. `text` and `id` are two ways of naming the same target, so
 * either one satisfies the requirement -- which is why the platform's
 * rule is "both missing", not "either missing".
 *
 * EVERY member of `requiredAny` is a way of naming the target, so all of
 * them are returned. Returning only the first one would classify `id` as
 * "in the model but not a target", which contradicts both the platform's
 * own rule and the `tapOn` row's own note.
 */
function targetArgumentsOf(kind) {
  const spec = STEP_ARGUMENTS[kind];
  if (!spec) return [];
  const any = (spec.requiredAny ?? []).flat();
  if (any.length) return [...any];
  if ((spec.required ?? []).length) return [spec.required[0]];
  return [];
}

/**
 * The target argument to USE when the step is written with one.
 *
 * When the kind needs no target at all, there is none -- and the step is
 * written without any target argument.
 */
function targetArgumentOf(kind) {
  const targets = targetArgumentsOf(kind);
  if (targets.length) return targets[0];
  const spec = STEP_ARGUMENTS[kind];
  return spec?.primary ?? null;
}

/** The primary argument of a step kind (the one a bare value fills). */
function spec_primaryOf(kind) {
  return STEP_ARGUMENTS[kind]?.primary ?? null;
}

/* ------------------------------------------------------------------ */
/* 3. the parameter fidelity, MEASURED by running the importer        */
/* ------------------------------------------------------------------ */

/** A YAML value of the right shape for a Maestro parameter type. */
function valueOfType(type) {
  if (/Integer|Long|Int\b/.test(type)) return '1';
  if (/Boolean/.test(type)) return 'true';
  if (/List/.test(type)) return { list: true };
  if (/Selector|Union/.test(type)) return { map: { id: 'probe' } };
  return 'probe';
}

/** A Maestro step written as YAML, from the given arguments. */
function stepYaml(command, entries) {
  const lines = [`- ${command}:`];
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      lines.push(`    ${key}: ${value}`);
    } else if (value.map) {
      lines.push(`    ${key}:`);
      for (const [k, v] of Object.entries(value.map)) lines.push(`      ${k}: ${v}`);
    } else {
      lines.push(`    ${key}: []`);
    }
  }
  return lines.join('\n');
}

/** What the importer does with one step. */
function runStep(body) {
  const flow = parseFlow(`appId: ${fixtures.appId}\n---\n${body}\n`, { syntax: 'maestro' });
  const imported = importFlow(flow, { file: 'flows/probe.yaml', projectUid: 'p1' });
  const steps = (imported.cases ?? []).flatMap((c) => c.steps);
  return {
    mapped: steps.length,
    warnings: imported.warnings.length,
    reason: imported.unsupported[0]?.reason ?? null,
  };
}

/**
 * Why a step of this kind still maps when it names no target.
 *
 * Two mechanisms exist, and both are facts about the platform's own
 * model rather than about Maestro:
 *
 *   * the kind has NO required target at all (`takeScreenshot` may be
 *     taken without a name), so nothing is missing;
 *   * the target can be INHERITED from the Flow header
 *     (`launchApp` takes the `appId` the file declares).
 *
 * Returns null when neither applies -- and then the step really is
 * rejected with `missing-argument`.
 */
function noTargetReason(kind) {
  const spec = STEP_ARGUMENTS[kind];
  if (!spec) return null;
  const needs = (spec.required ?? []).length > 0 || (spec.requiredAny ?? []).length > 0;
  if (!needs) return '该步骤种类没有必填目标';
  if (kind === 'launchApp') return '`launchApp` 的 `appId` 由 Flow 头继承';
  return null;
}

/**
 * Measures what the importer really does with the parameters of a command.
 *
 * THREE cases are measured, because they behave differently:
 *
 *   1. the step carries an in-model TARGET as well -> the out-of-model
 *      parameter is kept in the step and reported as a warning;
 *   2. the step carries ONLY out-of-model parameters -> the step names
 *      no target at all, so the importer rejects the WHOLE step with
 *      `missing-argument`. This is the case the round-2 review found:
 *      "保留原文并告警" was claimed for every out-of-model parameter, but
 *      a selector that carries only `below:` (or `childOf:`, ...) is
 *      not mapped at all;
 *   3. the step carries only an in-model parameter that does NOT name the
 *      target (`point`, `index`, ...) -> the same rejection, but for a
 *      different reason: the parameter is in the model, yet the step
 *      still names no target.
 *
 * The cell says WHICH parameters fall into which case -- by name, not
 * only by count, so a reader can tell which parameter is which.
 */
function measureParameterFidelity(command, modelKind, params) {
  const model = modelParams(modelKind);
  const out = params.filter((p) => !model.has(p.name));
  if (!out.length) {
    return {
      cell: `Maestro 的参数（${params.length} 个）全部在模型内`,
      out: [],
    };
  }

  const target = targetArgumentOf(modelKind);
  const targetValue = modelKind === 'launchApp' ? fixtures.appId : 'probe';
  const targets = targetArgumentsOf(modelKind);

  // The in-model parameters that are NOT a way of naming the target.
  // Every member of `requiredAny` IS a way of naming the target, so
  // only the parameters outside that set are "not a target".
  const inModelNonTarget = params.filter(
    (p) => model.has(p.name) && !targets.includes(p.name) && p.name !== spec_primaryOf(modelKind),
  );

  let keptAndWarned = 0;
  let rejectedWithTarget = 0;
  let missingArgument = 0;
  let stillMapped = 0;
  const keptNames = [];
  const rejectedNames = [];
  const missingNames = [];
  const stillNames = [];

  for (const p of out) {
    const value = valueOfType(p.type);
    const withTarget = runStep(stepYaml(command, [[target, targetValue], [p.name, value]]));
    if (withTarget.mapped > 0 && withTarget.warnings > 0) { keptAndWarned += 1; keptNames.push(p.name); }
    else if (withTarget.mapped === 0) { rejectedWithTarget += 1; rejectedNames.push(p.name); }

    const onlyOut = runStep(stepYaml(command, [[p.name, value]]));
    if (onlyOut.mapped === 0 && onlyOut.reason === 'missing-argument') { missingArgument += 1; missingNames.push(p.name); }
    else if (onlyOut.mapped > 0) { stillMapped += 1; stillNames.push(p.name); }
  }

  // The same two cases for the in-model parameters that do not name the
  // target: `point` on `tapOn` is the classic one -- it is inside the
  // model, but a step that gives ONLY a point names no target, so the
  // whole step is rejected.
  const inModelRejected = [];
  const inModelMapped = [];
  for (const p of inModelNonTarget) {
    const value = valueOfType(p.type);
    const onlyIt = runStep(stepYaml(command, [[p.name, value]]));
    if (onlyIt.mapped === 0 && onlyIt.reason === 'missing-argument') inModelRejected.push(p.name);
    else if (onlyIt.mapped > 0) inModelMapped.push(p.name);
  }

  const n = out.length;
  const outNames = out.length <= 2
    ? `模型外：${out.map((p) => `\`${p.name}\``).join(' / ')}`
    : `模型外 ${n} 个（相对定位 / 状态过滤 / 尺寸容差等）`;
  const inModel = params.filter((p) => model.has(p.name)).map((p) => `\`${p.name}\``).join(' / ');

  // The cell states WHICH parameter is which case. A count alone does not
  // say what the reader needs to know: which parameter still maps, which
  // one is refused.
  const list = (names) => names.map((x) => `\`${x}\``).join(' / ');

  let measured = `——**实测**（模型外参数逐个实跑导入器）：与模型内目标同时给出时 ${keptAndWarned}/${n} 条保留原文并告警、整步仍映射`;
  if (rejectedWithTarget) measured += `，${rejectedWithTarget}/${n} 条整步判 \`missing-argument\``;
  measured += `；只给模型外参数时 ${missingArgument}/${n} 条整步判 \`missing-argument\``;
  if (stillMapped) {
    const why = noTargetReason(modelKind);
    measured += `，其余 ${stillMapped}/${n} 条仍映射（${why ?? '该步骤种类没有必填目标'}）`;
  }
  // WHICH ones -- by name, so the cell is a measurement and not a tally.
  const which = [];
  if (stillNames.length) which.push(`只给这些时仍映射：${list(stillNames)}`);
  if (missingNames.length) which.push(`只给这些时整步判 \`missing-argument\`：${list(missingNames)}`);
  if (which.length) measured += `。**逐个**：${which.join('；')}`;
  if (inModelNonTarget.length) {
    const parts = [];
    if (inModelRejected.length) parts.push(`只给 ${list(inModelRejected)} 时整步判 \`missing-argument\``);
    if (inModelMapped.length) parts.push(`只给 ${list(inModelMapped)} 时仍映射`);
    measured += `。**模型内但不是目标**的 ${inModelNonTarget.length} 个参数（${list(inModelNonTarget.map((p) => p.name))}）：${parts.join('，')}`;
  }

  return {
    cell: `在模型内：${inModel}；${outNames}${measured}`,
    out: out.map((p) => p.name),
  };
}

/* ------------------------------------------------------------------ */
/* 4. the verdicts, DERIVED from the byte-code action model            */
/* ------------------------------------------------------------------ */

/**
 * The measured action of every Maestro command.
 *
 * `measureActions` reads the shipped byte-code and says which orchestra
 * command class each Maestro command compiles into, plus the VARIANT
 * that tells two commands of the same class apart (a tap / a double tap
 * / a long press; a visible / a not-visible / a wait assertion).
 */
const ACTIONS = measureActions();
if (!ACTIONS) {
  console.log('SKIP no Maestro installation found (the verdict groups need its byte-code).');
  console.log('     Set ATS606_MAESTRO_HOME to the Maestro directory.');
  process.exit(2);
}

/**
 * The verdict of every command, derived from the action model.
 *
 * The GROUP is not written here: it comes from `verdictOf(action)`, which
 * combines the measured action with the platform table. What IS written
 * here is the NOTE -- the human-readable explanation of the same verdict,
 * and the platform step kind the row points at.
 *
 * A command whose Maestro spelling is not a field of `YamlFluentCommand`
 * (the `action:` navigation commands, for instance) has no measured
 * action; those are listed in `NO_ACTION` with their reason.
 */
const NOTE = {
  assertVisible: '语义：断言元素可见——本平台的断言形如 `{visible: <目标>}`，命令形态与 Maestro 的 `assertVisible` 一致（一步对一步，同一个动作）。**等待语义不完全等价**，但等待不决定分组：Maestro 的 fluent 断言固定重试 7 秒，本平台 Runner 的默认等待是 `DEFAULT_WAIT.timeoutMs = 5000`（ATS-603 的 `server/adapters/android-runner.mjs`，可由 Runner 选项覆盖）。差异记在本列与「参数保真」列。',
  assertNotVisible: '语义：断言元素**不可见**——本平台**能表达**这个语义，命令形态也与 Maestro 一致（都是一步断言）：线性语法 `assert notVisible "X"` 实测映射为 `assertVisible{notVisible}`，YAML 用 `assert:` 块；Runner 按限定词区分两种断言（`visible` 失败于元素缺失，`notVisible` 失败于元素存在，见 `android-runner.mjs` 的 `assertVisible`）。**拼写不被接受属于导入侧**：Maestro 的拼写 `assertNotVisible` 不在 ATS-602 的语义拼写表里，导入时按 `unknown-command` 进导入报告——这不改变分组。**等待语义不完全等价**（`notVisible` 在本平台的等待上限是 `min(5000, 2000)` ms，Maestro 是 7 秒 fluent 重试）。',
  extendedWaitUntil: '语义：等待元素**可见**或**不可见**。Maestro 的这条命令与 `assertVisible` / `assertNotVisible` **编译成同一个命令类**（`AssertConditionCommand`）——字节码里 `YamlFluentCommand.extendedWait` 构造的是 `AssertConditionCommand(Condition(visible | notVisible), timeout, label, optional)`，**只多一个可配的 timeout**。⇒ 本平台用 `assertVisible`（加 `visible` / `notVisible` 限定词）表达同一步，**命令形态一致（一步对一步）**；`timeout` 记在「参数保真」与本列（Maestro 的 7 秒 fluent 重试 vs 本平台 Runner 默认 5000 ms），**等待长短不改变这一步是什么，不参与分组**。Maestro 的拼写不在 ATS-602 的语义拼写表里，导入时按 `unknown-command` 进导入报告——这属于导入侧，不改变分组。',
  launchApp: '语义：启动被测 App——命令形态与 Maestro 的 `launchApp` 一致（一步启动一个 App）。本平台的 `launchApp` 以 `appId` 为主参数（别名 `app`/`package`/`packageName`/`bundleId`），Flow 头部声明了 `appId` 时步骤可继承。Maestro 的 `launchApp` 还会按参数附带清 keychain / 清状态 / 设权限（`Orchestra.launchAppCommand` 的字节码里依次调用 `clearKeychain`→`clearAppState`→`setPermissions`→`launchApp`），**这三样本平台都没有对应步骤**——这是保真度差异，记在「参数保真」列与本列，不改变分组。',
  takeScreenshot: '语义：截屏——命令形态与 Maestro 的 `takeScreenshot` 一致（一步截一张）。本平台的落盘路径走 ATS-209 的证据路径校验与 SHA-256。Maestro 还能 `cropOn` 裁剪，本平台没有这个参数——保真度差异，不改变分组。',
  tapOn: '语义：点按元素——命令形态与 Maestro 的 `tapOn` 一致（一步点一个元素）。本平台的目标是**文本**或**资源 id`，**两者任一即可**（只有**两者皆缺**才判 `missing-argument`——只给 `id` 就能映射）；并按 ATS-601 要求 `ui.tap` + `ui.hierarchy` 同时满足。Maestro 的元素选择器远比这丰富（相对定位、状态过滤、尺寸容差等），本平台只认少数几个参数——保真度差异，记在「参数保真」列，不改变分组。',
  startRecording: '语义：开始录屏。**命令形态不同**：本平台的 `recordScreen` 是**一步**（录一段），Maestro 是「开始/停止」**配对**命令⇒**配对语义在单步模型里无处安放**——**动作（录屏）本平台能表达，表达不出来的是「开始/结束」这对边界**，所以判「部分可映射」。Maestro 的拼写也不在 ATS-602 的拼写表里，导入时按 `unknown-command` 进导入报告（导入侧）。',
  stopRecording: '语义：结束录屏。与 `startRecording` 同一条判定——**命令形态不同**（配对 vs 单步）：动作本平台能表达，表达不出来的是「开始/结束」这对边界；拼写也不被导入器接受（导入侧）。',
};

/**
 * The commands whose Maestro spelling is NOT a field of
 * `YamlFluentCommand`, so the byte-code carries no action for them.
 *
 * `back`, `hideKeyboard`, `scroll`, `clearKeychain` and `pasteText` are
 * Maestro's `action:` navigation commands: one YAML field holds a STRING
 * that is matched against the `YamlNavigationAction` enum, and the enum
 * value decides which command is built. The action is therefore not
 * readable from a per-field branch -- it is readable from the enum
 * switch, which the action model does not resolve.
 *
 * They are all unmappable for the same reason (the platform has no
 * navigation / keyboard / clipboard step), so the verdict does not depend
 * on the missing measurement. Each one is listed here so that a command
 * without a measured action is an EXPLICIT entry, never a silent one.
 */
const NO_ACTION = {
  back: '本平台**没有键盘处理与按键步骤**；另：`back` 在 iOS 上是**空操作**（`IOSDriver.backPress` 的字节码体只有一条 `return`）',
  hideKeyboard: '本平台**没有键盘处理与按键步骤**',
  scroll: '本平台**没有手势步骤**',
  clearKeychain: '本平台没有该步骤；`clearKeychain` 是 **iOS 专属**命令⇒ iOS 用例**无法保证从干净状态起跑**（登录态跨用例泄漏）',
  pasteText: '本平台六类步骤里**没有剪贴板操作**',
};

/** The reason for every command the platform's model has no semantics for. */
const UNMAPPABLE = {
  inputText: '本平台六类步骤里**没有文本输入**',
  inputRandomEmail: '本平台六类步骤里**没有文本输入**',
  inputRandomPersonName: '本平台六类步骤里**没有文本输入**',
  inputRandomNumber: '本平台六类步骤里**没有文本输入**',
  inputRandomText: '本平台六类步骤里**没有文本输入**',
  inputRandomCityName: '本平台六类步骤里**没有文本输入**',
  inputRandomCountryName: '本平台六类步骤里**没有文本输入**',
  inputRandomColorName: '本平台六类步骤里**没有文本输入**',
  eraseText: '本平台六类步骤里**没有文本输入**',
  copyTextFrom: '本平台六类步骤里**没有剪贴板操作**',
  pasteText: '本平台六类步骤里**没有剪贴板操作**',
  setClipboard: '本平台六类步骤里**没有剪贴板操作**',
  doubleTapOn: '本平台**没有手势步骤**',
  longPressOn: '本平台**没有手势步骤**',
  scroll: '本平台**没有手势步骤**',
  scrollUntilVisible: '本平台**没有手势步骤**',
  swipe: '本平台**没有手势步骤**',
  hideKeyboard: '本平台**没有键盘处理与按键步骤**',
  back: '本平台**没有键盘处理与按键步骤**；另：`back` 在 iOS 上是**空操作**（`IOSDriver.backPress` 的字节码体只有一条 `return`）',
  pressKey: '本平台**没有键盘处理与按键步骤**',
  clearKeychain: '本平台没有该步骤；`clearKeychain` 是 **iOS 专属**命令⇒ iOS 用例**无法保证从干净状态起跑**（登录态跨用例泄漏）',
  openLink: '本平台**没有对应的步骤**，也没有对应的 capability',
  setPermissions: '本平台**没有对应的步骤**，也没有对应的 capability',
  setLocation: '本平台**没有对应的步骤**，也没有对应的 capability',
  travel: '本平台**没有对应的步骤**，也没有对应的 capability',
  setOrientation: '本平台**没有对应的步骤**，也没有对应的 capability',
  setDarkMode: '本平台**没有对应的步骤**，也没有对应的 capability',
  toggleDarkMode: '本平台**没有对应的步骤**，也没有对应的 capability',
  assertDarkMode: '本平台**没有对应的步骤**，也没有对应的 capability',
  assertLightMode: '本平台**没有对应的步骤**，也没有对应的 capability',
  setAirplaneMode: '本平台**没有对应的步骤**；且**飞行模式在 iOS 上不生效**（驱动只打一条 warn）',
  toggleAirplaneMode: '本平台**没有对应的步骤**；且**飞行模式在 iOS 上不生效**（驱动只打一条 warn）',
  addMedia: '本平台**没有对应的步骤**，也没有对应的 capability',
  assertTrue: '本平台的断言只有 `visible` / `notVisible` 两种限定词，**没有任意表达式断言**',
  assertScreenshot: '本平台**没有视觉比对**（只有取证 `takeScreenshot`）',
  waitForAnimationToEnd: '本平台**没有等待步骤**',
  extendedWaitUntil: '本平台**没有等待步骤**',
  evalScript: '本平台**不执行 Flow 里的任意代码**（解析器只读文本），用例也是**扁平列表**（无子流程、无重复/重试结构）',
  runScript: '本平台**不执行 Flow 里的任意代码**（解析器只读文本），用例也是**扁平列表**（无子流程、无重复/重试结构）',
  runFlow: '本平台**不执行 Flow 里的任意代码**（解析器只读文本），用例也是**扁平列表**（无子流程、无重复/重试结构）',
  repeat: '本平台**不执行 Flow 里的任意代码**（解析器只读文本），用例也是**扁平列表**（无子流程、无重复/重试结构）',
  retry: '本平台**不执行 Flow 里的任意代码**（解析器只读文本），用例也是**扁平列表**（无子流程、无重复/重试结构）',
  assertWithAI: '**实验性** AI 命令：Maestro 自己标注 experimental；本平台不承诺 AI 断言能力（AI 能力属 ATS-401/ATS-403 的契约层，未做端到端实测）',
  assertNoDefectsWithAI: '**实验性** AI 命令：Maestro 自己标注 experimental；本平台不承诺 AI 断言能力（AI 能力属 ATS-401/ATS-403 的契约层，未做端到端实测）',
  extractTextWithAI: '**实验性** AI 命令：Maestro 自己标注 experimental；本平台不承诺 AI 断言能力（AI 能力属 ATS-401/ATS-403 的契约层，未做端到端实测）',
  clearState: '本平台**没有「重置 App 状态」这一步**。Maestro 的 `clearState` **不启动 App**（`Orchestra.clearStateCommand` 的字节码里只调 `clearAppState` 与 `setPermissions`，没有 `launchApp`）⇒ 它与 `launchApp` 没有「可映射的那一半」。`launchApp` 虽有模型内的 `clearState` 参数，但**当前 Runner 不执行它**（`android-runner.mjs` 的 `launchApp` 只读 `appId`）',
  killApp: '本平台**没有「强杀 App」这一步**。Maestro 的 `killApp` **不启动 App**（`Orchestra.killAppCommand` 只调 `killApp`）⇒ 与 `launchApp` 没有「可映射的那一半」',
  stopApp: '本平台**没有「停止 App」这一步**。Maestro 的 `stopApp` **不启动 App**（`Orchestra.stopAppCommand` 只调 `stopApp`）⇒ 与 `launchApp` 没有「可映射的那一半」',
};

/* ------------------------------------------------------------------ */
/* 5. the rows                                                         */
/* ------------------------------------------------------------------ */

/**
 * The platform step kind a row points at.
 *
 * It comes from the DERIVED verdict, so the cell can never name a step
 * kind the action does not map to. The qualifier is part of it: the
 * platform expresses "not visible" as the `assertVisible` step with the
 * `notVisible` qualifier, and the cell says so.
 */
function kindCellOf(verdict) {
  if (!verdict.kind) return '—';
  if (verdict.qualifier) return `\`${verdict.kind}\` + \`${verdict.qualifier}\` 限定词`;
  return `\`${verdict.kind}\``;
}

const groups = { 可映射: [], 部分可映射: [], 不映射: [] };
const missing = [];
for (const name of Object.keys(fixtures.commands)) {
  const b = behaviour[name];
  const importer = b.mapped
    ? `映射成功 → \`${b.kinds.join('`/`')}\``
    : `进导入报告：\`${b.reasons.join('+')}\``;

  // The verdict is DERIVED from the measured action and the platform
  // table -- it is not written down anywhere. A command the byte-code
  // does not describe is a FAILURE, not a guess.
  const action = ACTIONS[name];
  if (!action) {
    missing.push(`${name} (the byte-code carries no action for it)`);
    continue;
  }
  let verdict;
  try {
    verdict = verdictOf(action);
  } catch (e) {
    missing.push(`${name} (${e.message})`);
    continue;
  }

  const kind = kindCellOf(verdict);
  const modelKind = verdict.kind;

  if (verdict.verdict === '不映射') {
    // An unmappable row names NO step kind. Its reason is the authored
    // note for that command; a command without one is a failure.
    const reason = NOTE[name] ?? UNMAPPABLE[name] ?? NO_ACTION[name];
    if (!reason) {
      missing.push(`${name} (no reason given)`);
      continue;
    }
    groups['不映射'].push(`| \`${name}\` | — | ${importer} | — | ${reason} |`);
    continue;
  }

  // A mappable / partially mappable row: the note explains the verdict.
  const note = NOTE[name];
  if (!note) {
    missing.push(`${name} (no note given)`);
    continue;
  }

  const params = maestroParams(name);
  let paramCell;
  if (!params) {
    paramCell = '—';
  } else if (!b.mapped && b.reasons.includes('unknown-command')) {
    // The spelling itself is refused, so the importer never reaches the
    // ARGUMENTS: the parameter fidelity does not apply to this command.
    // That is measured, not assumed -- the reason is the one the
    // importer really reported.
    const out = params.filter((p) => !modelParams(modelKind).has(p.name));
    paramCell = `Maestro 的参数共 ${params.length} 个（其中模型外 ${out.length} 个）——**实测**：Maestro 的拼写 \`${name}\` 不在 ATS-602 的语义拼写表里，导入器在读参数**之前**就判 \`unknown-command\`（0 条告警），⇒ 本平台的参数保真**对本命令不适用**`;
  } else {
    paramCell = measureParameterFidelity(name, modelKind, params).cell;
  }
  groups[verdict.verdict].push(`| \`${name}\` | ${kind} | ${importer} | ${paramCell} | ${note} |`);
}
if (missing.length) {
  console.log(`FAIL these commands have no derived verdict: ${missing.join(', ')}`);
  process.exit(1);
}

const out = [];
const GROUP_INDEX = { 可映射: 1, 部分可映射: 2, 不映射: 3 };
for (const [g, rows] of Object.entries(groups)) {
  out.push(`#### 8.5.${GROUP_INDEX[g]} ${g}（${rows.length} 条）`, '');
  out.push('| Maestro 命令 | 本平台对应步骤种类 | ATS-602 导入器对 Maestro 原拼写的实际处理 | 参数保真 | 说明 |');
  out.push('|---|---|---|---|---|');
  out.push(...rows);
  out.push('');
}
const tally = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
const mapped = Object.values(behaviour).filter((b) => b.mapped).length;
out.push(`<!-- TALLY mappable=${tally['可映射']} partial=${tally['部分可映射']} unmappable=${tally['不映射']} total=${Object.values(groups).flat().length} imported=${mapped} reported=${55 - mapped} -->`);
console.log(out.join('\n'));

fs.rmSync(WORK, { recursive: true, force: true });
