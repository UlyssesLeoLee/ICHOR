/**
 * ATS-606: generates the §8.5 rows of docs/25-MOBILE-APP-TESTING.md.
 *
 * WHY A GENERATOR
 * ---------------
 * The §8.5 table has three columns that are FACTS, not opinions:
 *
 *   * "ATS-602 导入器对 Maestro 原拼写的实际处理" -- what the importer
 *     really does with the Maestro spelling. Measured by running the
 *     importer over every fixture.
 *   * "参数保真" -- which of Maestro's own parameters are inside the
 *     platform's model (ATS-602's `STEP_ARGUMENTS`) and which are not.
 *     Maestro's parameter list is read out of the shipped byte-code
 *     (`Yaml*` classes of maestro-orchestra.jar).
 *   * the counts at the end of the section.
 *
 * Those three must not be typed by hand: a hand-written table drifts from
 * the code the moment either changes, and that is exactly the failure the
 * reviewer caught in round 1 (the table claimed 7 mappable commands while
 * the importer maps 4).
 *
 * The SEMANTIC verdict (which group a command belongs to, and why) is
 * authored -- it is a judgement about the platform's model, not a fact
 * about the code. It lives in this file, next to the facts it is
 * combined with, so the two can be reviewed together.
 *
 * The generated block is delimited in the design document by
 * `<!-- ATS606-ROWS-START -->` and `<!-- ATS606-ROWS-END -->`.
 *
 * usage: node tools/ats606-probes/gen-section-rows.mjs [repo]
 * exit:  0 rows generated, 1 a command has no authored verdict, 2 the
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
    mapped: report.mappedSteps,
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
/** The declared fields of a class -- Maestro's own parameter list. */
function fieldsOf(file) {
  const t = execFileSync('javap', ['-p', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return t.split(/\r?\n/)
    .filter((l) => /^\s{2}private final /.test(l))
    .map((l) => /private final ([\w.$<>\[\], ?]+) (\w+);/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => m[2]);
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
    return fieldsOf(extract('maestro-orchestra.jar', `maestro/orchestra/yaml/${cls}.class`))
      .filter((p) => !['label', 'optional'].includes(p));
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

/* ------------------------------------------------------------------ */
/* 3. the authored semantic verdicts                                   */
/* ------------------------------------------------------------------ */

/**
 * The semantic verdict: which group a command belongs to, the platform
 * step kind it corresponds to, and why.
 *
 * This is a JUDGEMENT about the platform's model -- it cannot be measured.
 * The two sides it must agree with are measured: the importer's behaviour
 * (above) and the parameter lists (above). The probe checks the document
 * against all three.
 */
const VERDICT = {
  launchApp: {
    group: '可映射',
    kind: '`launchApp`',
    modelKind: 'launchApp',
    note: '语义：启动被测 App。本平台的 `launchApp` 以 `appId` 为主参数（别名 `app`/`package`/`packageName`/`bundleId`），Flow 头部声明了 `appId` 时步骤可继承。Maestro 的 `launchApp` 还会按参数附带清 keychain / 清状态 / 设权限（`Orchestra.launchAppCommand` 的字节码里依次调用 `clearKeychain`→`clearAppState`→`setPermissions`→`launchApp`），**这三样本平台都没有对应步骤**。',
  },
  tapOn: {
    group: '可映射',
    kind: '`tapOn`',
    modelKind: 'tapOn',
    note: '语义：点按元素。本平台的目标是**文本**或**资源 id**（任一即可，缺任一即判 `missing-argument`），并按 ATS-601 要求 `ui.tap` + `ui.hierarchy` 同时满足。Maestro 的元素选择器远比这丰富（相对定位、状态过滤、尺寸容差等），本平台只认少数几个参数。',
  },
  assertVisible: {
    group: '可映射',
    kind: '`assertVisible`',
    modelKind: 'assertVisible',
    note: '语义：断言元素可见。本平台的断言形如 `{visible: <目标>}`。**等待语义不完全等价**：Maestro 的 fluent 断言固定重试 7 秒，本平台 Runner 的默认等待是 `DEFAULT_WAIT.timeoutMs = 5000`（ATS-603 的 `server/adapters/android-runner.mjs`，可由 Runner 选项覆盖）。',
  },
  takeScreenshot: {
    group: '可映射',
    kind: '`takeScreenshot`',
    modelKind: 'takeScreenshot',
    note: '语义：截屏。本平台的落盘路径走 ATS-209 的证据路径校验与 SHA-256。Maestro 还能 `cropOn` 裁剪，本平台没有这个参数。',
  },
  assertNotVisible: {
    group: '部分可映射',
    kind: '`assertVisible` + `notVisible` 限定词',
    modelKind: 'assertVisible',
    note: '语义：断言元素**不可见**——本平台**能表达**这个语义（线性语法 `assert notVisible "X"` 实测映射为 `assertVisible{notVisible}`，YAML 用 `assert:` 块）。**但 Maestro 的拼写 `assertNotVisible` 不在 ATS-602 的语义拼写表里**，导入时按 `unknown-command` 进导入报告。语义可表达、拼写不被接受 ⇒ 判「部分可映射」。',
  },
  startRecording: {
    group: '部分可映射',
    kind: '`recordScreen`',
    modelKind: 'recordScreen',
    note: '语义：开始录屏。本平台的 `recordScreen` 是**一步**（录一段），Maestro 是「开始/停止」**配对**命令⇒**配对语义在单步模型里无处安放**，录屏的开始/结束边界表达不出来。Maestro 的拼写也不在 ATS-602 的拼写表里，导入时按 `unknown-command` 进导入报告。',
  },
  stopRecording: {
    group: '部分可映射',
    kind: '`recordScreen`',
    modelKind: 'recordScreen',
    note: '语义：结束录屏。与 `startRecording` 同一条判定——配对语义在单步模型里无处安放，拼写也不被导入器接受。',
  },
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
/* 4. the rows                                                         */
/* ------------------------------------------------------------------ */

const groups = { 可映射: [], 部分可映射: [], 不映射: [] };
const missing = [];
for (const name of Object.keys(fixtures.commands)) {
  const b = behaviour[name];
  const importer = b.mapped > 0
    ? `映射成功 → \`${b.kinds.join('`/`')}\``
    : `进导入报告：\`${b.reasons.join('+')}\``;

  if (VERDICT[name]) {
    const v = VERDICT[name];
    const mp = maestroParams(name);
    const model = modelParams(v.modelKind);
    const out = mp ? mp.filter((p) => !model.has(p)) : null;
    const inModel = mp ? mp.filter((p) => model.has(p)) : null;
    let paramCell;
    if (inModel === null) {
      paramCell = '—';
    } else if (out.length === 0) {
      paramCell = `Maestro 的参数（${mp.length} 个）全部在模型内`;
    } else if (out.length <= 2) {
      paramCell = `在模型内：${inModel.map((p) => `\`${p}\``).join(' / ')}；模型外：${out.map((p) => `\`${p}\``).join(' / ')}（保留原文并告警）`;
    } else {
      paramCell = `在模型内：${inModel.map((p) => `\`${p}\``).join(' / ')}；模型外 ${out.length} 个（相对定位 / 状态过滤 / 尺寸容差等）保留原文并告警`;
    }
    if (name === 'tapOn') {
      paramCell += '。**只给 `point` 而不给 `text`/`id` 的步骤，整步判 `missing-argument`**';
    }
    groups[v.group].push(`| \`${name}\` | ${v.kind} | ${importer} | ${paramCell} | ${v.note} |`);
  } else if (UNMAPPABLE[name]) {
    groups['不映射'].push(`| \`${name}\` | — | ${importer} | — | ${UNMAPPABLE[name]} |`);
  } else {
    missing.push(name);
  }
}
if (missing.length) {
  console.log(`FAIL these commands have neither a verdict nor a reason: ${missing.join(', ')}`);
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
const mapped = Object.values(behaviour).filter((b) => b.mapped > 0).length;
out.push(`<!-- TALLY mappable=${tally['可映射']} partial=${tally['部分可映射']} unmappable=${tally['不映射']} total=${Object.values(groups).flat().length} imported=${mapped} reported=${55 - mapped} -->`);
console.log(out.join('\n'));

fs.rmSync(WORK, { recursive: true, force: true });
