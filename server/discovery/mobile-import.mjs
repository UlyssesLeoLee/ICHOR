/**
 * ATS-602: the cross-engine CASE MODEL and the mobile Flow import mapping.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The platform has ONE case model: the TestDefinition of ATS-201/ATS-202
 * (file, title, line, uid). A mobile Flow is a DIFFERENT declaration of a
 * user journey. This module maps the one onto the other, and it does so
 * under two rules that the acceptance criterion of the task states:
 *
 *   1. a Flow maps onto the unified TestDefinition -- the mobile cases are
 *      first-class cases of the project, not a second kind of case;
 *   2. a step that CANNOT be mapped keeps its ORIGINAL TEXT and is MARKED
 *      as unsupported -- it is never silently dropped, and it is never
 *      "guessed" into an approximate step (docs/25 §4.2).
 *
 * THE STEP VOCABULARY
 * -------------------
 * The mapped step kinds are the ones ATS-601 froze, and they are the ones
 * the capability negotiation of ATS-601 already knows (docs/25 §3.3):
 *
 *   launchApp / tapOn / assertVisible / takeScreenshot / recordScreen /
 *   readLogs
 *
 * A Flow command that names none of them is NOT mappable. It is kept as an
 * UNSUPPORTED step: the original text, the line it was declared on, the
 * reason it did not map, and the suggestion of what to use instead.
 *
 * THE MAPPING IS BY SEMANTICS, NOT BY SPELLING
 * ---------------------------------------------
 * The design document is explicit: the compatibility judgement is made on
 * what a step DOES on the device, not on the YAML field names (docs/25
 * §8.2). So the table below is a table of SEMANTICS: each entry names the
 * semantic action ("launch the app", "tap an element"), and each semantic
 * action lists the SPELLINGS the Flow syntaxes may use for it.
 *
 * That is what makes the two syntaxes interchangeable: `launchApp` and
 * `launch` mean the same thing on the device, so they map to the same step
 * kind, so they produce the same UID.
 *
 * The spelling list here is the platform's OWN reading of the two syntaxes
 * it ships. The official compatibility judgement for any third party's
 * syntax belongs to ATS-606 (docs/25 §8): this table says what the
 * platform can read TODAY, not what it promises to read.
 *
 * THE UNSUPPORTED STEP
 * --------------------
 * An unsupported step is NOT an error and NOT a dropped step. It is a step
 * that keeps:
 *
 *   * `raw`       -- the original text, so that a reader can see what was
 *                   declared;
 *   * `line`      -- where it was declared;
 *   * `reason`    -- why it did not map (the command is unknown, the
 *                   arguments are not usable, ...);
 *   * `suggestion`-- the step kind that would do the same thing, when one
 *                   exists.
 *
 * The import report lists every one of them. The report is the deliverable
 * the task names ("用例映射规则与导入报告"), and it is DATA: it is produced
 * by the import and can be written out as JSON or as text.
 *
 * THE UID
 * -------
 * A mobile case enters the ATS-201 UID rules like every other case:
 * file + line is the basis, the title is the key (docs/25 §4.3). The
 * important property is that SWITCHING THE IMPORT METHOD does not change an
 * existing UID -- the same scenario, read from the same file at the same
 * line, gets the same UID whichever syntax read it. The basis is therefore
 * the POSITION, never the syntax, and never the file's syntax-specific
 * spelling of the title.
 */
import crypto from 'node:crypto';

import { deriveTestUid, normalizeTitleKey, pruneRegistry, provisionalTestUid } from '../uid.mjs';
import { MOBILE_STEP_KINDS } from '../adapters/mobile-target.mjs';

/* ------------------------------------------------------------------ */
/* The semantic vocabulary                                             */
/* ------------------------------------------------------------------ */

/**
 * The semantic actions the unified model knows, and the Flow commands that
 * mean each of them.
 *
 * The keys of this table are the STEP KINDS of the unified mobile case
 * model. The values are the SPELLINGS a Flow may use for the same action.
 *
 * A spelling is matched case-insensitively and ignoring the separators
 * (`_`, `-`, `.`), so `tap_on`, `tapOn` and `tap-on` are one command. That
 * normalisation is applied to the COMMAND only; the original spelling is
 * what the report quotes.
 *
 * The table is the "受控子集" (the controlled subset) of the design: the
 * steps that CAN be reversed are reversed, the ones that cannot are kept
 * as they are (docs/25 §4.2).
 */
export const STEP_SEMANTICS = Object.freeze({
  launchApp: Object.freeze(['launchApp', 'launch']),
  tapOn: Object.freeze(['tapOn', 'tap']),
  assertVisible: Object.freeze(['assertVisible', 'assert']),
  takeScreenshot: Object.freeze(['takeScreenshot', 'screenshot']),
  recordScreen: Object.freeze(['recordScreen', 'record']),
  readLogs: Object.freeze(['readLogs', 'logs']),
});

/**
 * The reverse table: the normalised spelling -> the step kind.
 *
 * It is built once, from `STEP_SEMANTICS`, so the two can never drift
 * apart: there is ONE place where a spelling is declared to mean
 * something.
 */
const SPELLING_TO_KIND = (() => {
  const map = new Map();
  for (const [kind, spellings] of Object.entries(STEP_SEMANTICS)) {
    for (const spelling of spellings) map.set(normaliseCommand(spelling), kind);
  }
  return map;
})();

/**
 * The step kinds this mapper may produce.
 *
 * They are the kinds ATS-601 froze, and the mapper may not invent a kind of
 * its own: a step kind that is not in the ATS-601 vocabulary would have no
 * capability requirement, and the capability negotiation of docs/25 §3.3
 * would have nothing to match it against.
 *
 * The check is made once, at load time, so a future edit that adds a kind
 * to `STEP_SEMANTICS` without adding it to the ATS-601 vocabulary fails
 * loudly instead of producing steps nobody can execute.
 */
for (const kind of Object.keys(STEP_SEMANTICS)) {
  if (!MOBILE_STEP_KINDS.includes(kind)) {
    throw new Error(
      `the mobile import maps to the step kind "${kind}", which is not in the ATS-601 `
      + `vocabulary (${MOBILE_STEP_KINDS.join(', ')})`,
    );
  }
}

/**
 * Normalises a command for the lookup.
 *
 * Case is folded and the separators are removed, so the lookup does not
 * depend on how the Flow happened to spell the word. It is NOT the
 * identity of the command: the original spelling is kept in the report.
 */
export function normaliseCommand(command) {
  return String(command ?? '').replace(/[\s_\-.]/g, '').toLowerCase();
}

/** The step kind a command means, or `null` when it means none. */
export function stepKindOf(command) {
  return SPELLING_TO_KIND.get(normaliseCommand(command)) ?? null;
}

/**
 * The commands that mean a step kind, for the report's suggestions.
 */
export function spellingsOf(kind) {
  return STEP_SEMANTICS[kind] ?? [];
}

/* ------------------------------------------------------------------ */
/* The arguments                                                       */
/* ------------------------------------------------------------------ */

/**
 * The arguments each step kind reads.
 *
 * `primary` is the argument a BARE value fills: in `- tapOn: "Login"` the
 * value is the text that is tapped, and in `- tapOn: {id: "x"}` the `id`
 * names the same argument. Which argument the bare value fills depends on
 * the STEP KIND, so the table is per kind and not global.
 *
 * `required` is the list of arguments a step cannot do without: `tapOn`
 * without a target cannot be executed, because there is nothing to tap.
 * So the mapper reports such a step as UNSUPPORTED, with the reason -- it
 * does not emit a step that would fail at run time with an error nobody
 * could act on.
 *
 * `aliases` maps a canonical argument to the names a Flow may spell it
 * with. An argument name that is in NO alias list is not part of the
 * unified model: it is KEPT in the step (nothing is silently dropped) and
 * REPORTED as an unknown argument.
 */
export const STEP_ARGUMENTS = Object.freeze({
  launchApp: Object.freeze({
    primary: 'appId',
    required: Object.freeze(['appId']),
    optional: Object.freeze(['clearState', 'clearAppState', 'arguments', 'permissions']),
    aliases: Object.freeze({ appId: Object.freeze(['appId', 'app', 'package', 'packageName', 'bundleId']) }),
  }),
  tapOn: Object.freeze({
    primary: 'text',
    required: Object.freeze(['text']),
    optional: Object.freeze(['id', 'index', 'point', 'retryTapIfNoChange', 'waitToSettleTimeoutMs']),
    aliases: Object.freeze({ text: Object.freeze(['text', 'textToTap', 'label', 'title']) }),
  }),
  assertVisible: Object.freeze({
    primary: 'text',
    required: Object.freeze(['text']),
    optional: Object.freeze(['id', 'index']),
    aliases: Object.freeze({ text: Object.freeze(['text', 'textToTap', 'label', 'title']) }),
  }),
  takeScreenshot: Object.freeze({
    primary: 'name',
    required: Object.freeze([]),
    optional: Object.freeze(['path']),
    aliases: Object.freeze({ name: Object.freeze(['name', 'text']), path: Object.freeze(['path', 'file', 'fileName']) }),
  }),
  recordScreen: Object.freeze({
    primary: 'name',
    required: Object.freeze([]),
    optional: Object.freeze(['path']),
    aliases: Object.freeze({ name: Object.freeze(['name', 'text']), path: Object.freeze(['path', 'file', 'fileName']) }),
  }),
  readLogs: Object.freeze({
    primary: 'path',
    required: Object.freeze([]),
    optional: Object.freeze(['since', 'until']),
    aliases: Object.freeze({ path: Object.freeze(['path', 'file', 'fileName', 'name']) }),
  }),
});

/* ------------------------------------------------------------------ */
/* The import                                                          */
/* ------------------------------------------------------------------ */

/**
 * The reasons a step may not be mapped.
 *
 * The vocabulary is closed: every unsupported step carries one of these,
 * so a reader can tell what KIND of problem it is. A step that is dropped
 * without a reason would be the failure mode the task forbids.
 */
export const UNSUPPORTED_REASON = Object.freeze({
  /** The command names no action the unified model knows. */
  UNKNOWN_COMMAND: 'unknown-command',
  /** The command is known, but the arguments it needs are missing. */
  MISSING_ARGUMENT: 'missing-argument',
  /** The command is known, but this qualifier is not supported. */
  UNSUPPORTED_QUALIFIER: 'unsupported-qualifier',
});

/**
 * Imports a parsed Flow onto the unified case model.
 *
 * @param {object} flow       the parsed Flow (see `mobile-flow.mjs`)
 * @param {object} [opts]
 * @param {string} opts.file  the project-relative path of the Flow file
 * @param {string} [opts.projectUid]  the project the file belongs to
 * @param {object} [opts.registry]    the UID registry of the project
 *
 * Returns:
 *   {
 *     file:    string,
 *     syntax:  string,
 *     appId:   string | null,
 *     cases:   [ MobileCase ],   -- the TestDefinitions the Flow produced
 *     unsupported: [ UnsupportedStep ],
 *     warnings: [ { line, message } ],  -- arguments outside the model
 *     errors:  [ { line, message } ],
 *     registry: object | null     -- the registry cell, when one was given
 *   }
 *
 * A MobileCase is:
 *   {
 *     id, uid, uidSource, uidStable, uidBasis,
 *     file, title, line, source: 'mobile', engine: 'mobile', level: 'ST',
 *     appId, tags, steps: [ MobileStep ],
 *     unsupportedCount: number
 *   }
 *
 * and a MobileStep is:
 *   {
 *     kind: string,        -- the unified step kind
 *     args: object,        -- the canonical arguments
 *     assertion: object|null,
 *     line: number,
 *     raw: string
 *   }
 */
export function importFlow(flow, { file = '', projectUid = null, registry = null } = {}) {
  const errors = [...(flow?.errors ?? [])];
  const warnings = [];
  const cases = [];
  const unsupported = [];

  for (const scenario of flow?.scenarios ?? []) {
    const mapped = mapScenario(scenario, { file, unsupported, warnings, appId: flow?.appId ?? null });
    if (!mapped) continue;
    cases.push(mapped);
  }

  // The UIDs. The basis is the POSITION (file + line), so that switching the
  // import method -- or the syntax the file is written in -- does not move
  // an existing UID (docs/25 §4.3).
  const resolved = resolveMobileUids({ cases, projectUid, registry, file });

  return {
    file,
    syntax: flow?.syntax ?? null,
    appId: flow?.appId ?? null,
    cases: resolved.cases,
    unsupported,
    warnings,
    errors,
    // The registry with THIS project's cell replaced. The other projects'
    // cells are carried over untouched: an import of one project must not
    // erase the memory of another one.
    registry: {
      version: registry?.version ?? 1,
      projects: {
        ...(registry?.projects ?? {}),
        ...(projectUid && resolved.registry ? { [projectUid]: resolved.registry } : {}),
      },
    },
  };
}

/**
 * Maps one scenario onto a case.
 *
 * The scenario's TITLE is the case's title; without one, the title is
 * derived from the position, so that the case still has a stable identity
 * (and the report says the title was derived).
 *
 * The APP of the case is the app the Flow declares: the scenario's own
 * `appId` when it has one, the file's `appId` otherwise. A `launchApp`
 * step that names no app therefore inherits the file's declaration -- the
 * step is then mappable, and the app it launches is the file's app.
 */
function mapScenario(scenario, { file, unsupported, warnings, appId }) {
  const title = scenario.title && scenario.title.trim() ? scenario.title.trim() : null;
  const steps = [];
  let unsupportedCount = 0;

  for (const step of scenario.steps ?? []) {
    const mapped = mapStep(step, { file, unsupported, warnings, appId: scenario.appId ?? appId });
    if (!mapped) {
      unsupportedCount += 1;
      continue;
    }
    steps.push(mapped);
  }

  return {
    // The file and the line are the POSITION of the case, and they are
    // part of its identity: the UID basis is derived from them.
    file,
    title: title ?? derivedTitle(file, scenario.line),
    line: scenario.line,
    appId: scenario.appId ?? appId ?? null,
    tags: scenario.tags ?? [],
    env: scenario.env ?? {},
    steps,
    unsupportedCount,
  };
}

/**
 * The title of a scenario that has none.
 *
 * The title is part of the UID key, so it must be DETERMINISTIC: the same
 * file at the same line always yields the same title. The position is
 * therefore what names an unnamed scenario.
 */
function derivedTitle(file, line) {
  return `mobile scenario at line ${line}`;
}

/**
 * Maps one step onto the unified step model.
 *
 * Returns the mapped step, or `null` when the step cannot be mapped -- in
 * which case the step has ALREADY been pushed onto the `unsupported` list,
 * with its original text, its line and the reason.
 */
function mapStep(step, { file, unsupported, warnings, appId }) {
  const kind = stepKindOf(step.command);
  if (!kind) {
    unsupported.push({
      file,
      line: step.line,
      raw: step.raw,
      command: step.command,
      reason: UNSUPPORTED_REASON.UNKNOWN_COMMAND,
      reasonText: step.command
        ? `the command "${step.command}" names no action the unified mobile case model knows`
        : 'the step names no command at all (it carries only options)',
      suggestion: null,
    });
    return null;
  }

  // The linear syntax writes the qualifier as a second word; the maestro
  // syntax writes the assertion as a separate key. Both say the same thing,
  // so both are read into the same `assertion`.
  if (step.qualifier && !isSupportedQualifier(kind, step.qualifier)) {
    unsupported.push({
      file,
      line: step.line,
      raw: step.raw,
      command: step.command,
      reason: UNSUPPORTED_REASON.UNSUPPORTED_QUALIFIER,
      reasonText: `the qualifier "${step.qualifier}" of "${step.command}" is not supported`,
      suggestion: kind,
    });
    return null;
  }

  const spec = STEP_ARGUMENTS[kind];
  const { args, unknown } = canonicalArguments(kind, spec, step.args ?? {});

  // A `launchApp` that names no app takes the app the Flow declares. That
  // is not a guess: the Flow says which app the whole file drives, and the
  // step inherits it.
  if (kind === 'launchApp' && (args.appId === undefined || args.appId === null || String(args.appId).trim() === '')
    && appId) {
    args.appId = appId;
  }

  if (unknown.length) {
    // The STEP maps; the ARGUMENTS it carries do not all belong to the
    // unified model. They are kept in the step and reported -- never
    // silently dropped.
    warnings.push({
      line: step.line,
      message: `the step "${kind}" carries the argument(s) ${unknown.join(', ')}, which are not part of the unified mobile case model; they are kept as they are`,
      raw: step.raw,
    });
  }

  const missing = spec.required.filter((name) => {
    const value = args[name];
    return value === undefined || value === null || String(value).trim() === '';
  });
  if (missing.length) {
    unsupported.push({
      file,
      line: step.line,
      raw: step.raw,
      command: step.command,
      reason: UNSUPPORTED_REASON.MISSING_ARGUMENT,
      reasonText: `the step "${kind}" needs ${missing.join(', ')}, which the Flow does not give`,
      suggestion: kind,
    });
    return null;
  }

  return {
    kind,
    args,
    assertion: readAssertionOf(step, kind, args),
    line: step.line,
    raw: step.raw,
  };
}

/**
 * The canonical arguments of a step.
 *
 * A bare value (the short form `- tapOn: "Login"`) fills the kind's
 * PRIMARY argument. A named argument is canonicalised through the kind's
 * alias table. An argument that is in no alias table is kept under its own
 * name and reported.
 */
function canonicalArguments(kind, spec, rawArgs) {
  const args = {};
  const unknown = [];
  const aliasOf = new Map();
  for (const [canonical, aliases] of Object.entries(spec.aliases)) {
    for (const alias of aliases) aliasOf.set(alias, canonical);
  }

  for (const [name, value] of Object.entries(rawArgs)) {
    if (name === 'value') {
      // The bare value: it fills the primary argument unless the Flow also
      // named that argument explicitly.
      if (args[spec.primary] === undefined) args[spec.primary] = value;
      continue;
    }
    const canonical = aliasOf.get(name);
    if (canonical) {
      args[canonical] = value;
      continue;
    }
    args[name] = value;
    if (!spec.optional.includes(name)) unknown.push(name);
  }
  return { args, unknown };
}

/**
 * The assertion of a step.
 *
 * The maestro syntax carries it as a separate key (`assert: {visible: X}`);
 * the linear syntax carries it as the qualifier of an `assert` verb. Both
 * end up as the same assertion data.
 *
 * An `assertVisible` step carries the assertion in its COMMAND: the
 * command says what is asserted, so the assertion is `{visible: <target>}`
 * whether the Flow wrote it as `assertVisible: "Welcome"`,
 * `assert: {visible: "Welcome"}` or `assert visible "Welcome"`.
 *
 * That matters beyond tidiness: the assertion is part of the step's BODY
 * fingerprint, and the fingerprint has to be the same whichever syntax
 * read the Flow -- otherwise the same case would have two identities.
 */
function readAssertionOf(step, kind, args) {
  if (step.assertion && typeof step.assertion === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(step.assertion)) {
      if (v === null || v === undefined) continue;
      out[k] = typeof v === 'object' ? JSON.stringify(v) : v;
    }
    if (Object.keys(out).length) return out;
  }
  if (kind === 'assertVisible') {
    // The qualifier says WHICH visibility is asserted; without one the
    // command itself says it: the element is asserted to be visible.
    const visibility = step.qualifier ?? 'visible';
    return { [visibility]: args.text ?? null };
  }
  return null;
}

/**
 * The qualifiers a step kind accepts.
 *
 * `assert` accepts `visible` and `notVisible`; the other kinds accept none.
 */
function isSupportedQualifier(kind, qualifier) {
  if (kind !== 'assertVisible') return false;
  return qualifier === 'visible' || qualifier === 'notVisible';
}

/* ------------------------------------------------------------------ */
/* The UIDs                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolves the UID of every imported case.
 *
 * The ladder is the ATS-201 one, applied to the mobile cases:
 *
 *   1. an explicit `@TC-<token>` in the title  -> `explicit`
 *   2. the registry knows this case by its BODY  -> `registry`
 *   3. the title key is unique in the import    -> `derived`
 *   4. the body fingerprint is unique           -> `derived-body`
 *   5. otherwise                                 -> `provisional`
 *
 * The BODY of a mobile case is the fingerprint of its steps. Two cases with
 * the same title and the same steps are the same case; two cases with the
 * same title and different steps are different cases -- and rule 2 is what
 * keeps the UID stable when the title is rewritten.
 *
 * The basis of the derived UID is the POSITION (file + line), NOT the
 * title. That is the property docs/25 §4.3 asks for: switching the import
 * method must not change an existing UID. The title key is only the
 * DISCRIMINATOR between the cases of one file.
 *
 * WITHOUT a project UID the cases cannot have a stable, project-scoped
 * identifier, so they get a PROVISIONAL one and `uidStable: false`. A UID
 * derived from a missing project would collide with another project's.
 */
function resolveMobileUids({ cases, projectUid, registry, file }) {
  const entries = registry?.projects?.[projectUid]?.entries ?? [];
  const byBody = new Map();
  for (const e of entries) {
    if (!e.bodyKey || !e.uid) continue;
    if (!byBody.has(e.bodyKey)) byBody.set(e.bodyKey, []);
    byBody.get(e.bodyKey).push(e);
  }
  const bodyCounts = new Map();
  for (const c of cases) {
    const key = bodyKeyOfCase(c);
    if (!key) continue;
    bodyCounts.set(key, (bodyCounts.get(key) ?? 0) + 1);
  }

  const titleCounts = new Map();
  for (const c of cases) {
    const key = normalizeTitleKey(c.title);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }

  const out = [];
  for (const c of cases) {
    const bodyKey = bodyKeyOfCase(c);
    const titleKey = normalizeTitleKey(c.title);
    const explicit = explicitUidOf(c.title);

    if (explicit) {
      out.push({ ...c, uid: explicit, uidSource: 'explicit', uidStable: true, uidBasis: 'explicit', bodyKey, titleKey });
      continue;
    }

    // The registry: the body fingerprint of the case, when it is unique in
    // the project. This is what keeps the UID when the title is rewritten.
    const hits = bodyKey ? (byBody.get(bodyKey) ?? []) : [];
    const uids = [...new Set(hits.map((h) => h.uid).filter(Boolean))];
    if (bodyKey && bodyCounts.get(bodyKey) === 1 && uids.length === 1) {
      out.push({ ...c, uid: uids[0], uidSource: 'registry', uidStable: true, uidBasis: 'body-key', bodyKey, titleKey });
      continue;
    }

    if (!projectUid) {
      // Without a project there is no project-scoped identifier to derive.
      const uid = provisionalTestUid('no-project', file, c.title, c.line, out.length + 1);
      out.push({
        ...c,
        uid,
        uidSource: 'provisional',
        uidStable: false,
        uidBasis: null,
        bodyKey,
        titleKey,
        ambiguity: {
          key: titleKey,
          reason: 'no-project-uid',
          candidates: [],
        },
      });
      continue;
    }

    if (titleCounts.get(titleKey) === 1) {
      const uid = deriveTestUid(projectUid, positionBasis(file, c.line, titleKey));
      out.push({ ...c, uid, uidSource: 'derived', uidStable: true, uidBasis: 'position-title', bodyKey, titleKey });
      continue;
    }

    // The title is shared. The body decides, when it is unique.
    if (bodyKey && bodyCounts.get(bodyKey) === 1) {
      const uid = deriveTestUid(projectUid, positionBasis(file, c.line, bodyKey));
      out.push({ ...c, uid, uidSource: 'derived-body', uidStable: true, uidBasis: 'body-key', bodyKey, titleKey });
      continue;
    }

    const uid = provisionalTestUid(projectUid, file, c.title, c.line, out.length + 1);
    out.push({
      ...c,
      uid,
      uidSource: 'provisional',
      uidStable: false,
      uidBasis: null,
      bodyKey,
      titleKey,
      ambiguity: {
        key: titleKey,
        reason: 'identical-title',
        candidates: cases.filter((x) => normalizeTitleKey(x.title) === titleKey)
          .map((x) => ({ file, title: x.title, line: x.line })),
      },
    });
  }

  return { cases: out, registry: mergeMobileRegistry(entries, out, file) };
}

/**
 * The basis of a derived UID.
 *
 * The POSITION is the basis and the title key is the discriminator: the
 * same file at the same line with the same title always yields the same
 * UID, and a case that is renamed in place keeps it (the registry finds it
 * by its body), while a case that MOVED is reported as a different
 * position.
 */
function positionBasis(file, line, discriminator) {
  return `${file}#${line}#${discriminator}`;
}

/**
 * The body fingerprint of a mobile case.
 *
 * The body of a mobile case is its STEPS: the sequence of kinds and
 * arguments. Two cases with the same steps are the same case even if
 * their titles differ, and two cases with the same title but different
 * steps are different cases.
 */
export function bodyKeyOfCase(c) {
  const text = (c.steps ?? []).map((s) => `${s.kind}:${stableJson(s.args)}:${stableJson(s.assertion)}`).join('|');
  if (!text) return null;
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Merges the imported cases into the UID registry.
 *
 * The rules are the ATS-201 ones: one entry per uid, an entry whose case
 * MOVED keeps the old position as an alias, and a stale entry is pruned
 * only when its file was part of THIS import.
 *
 * The registry is what makes the UID survive a retitle: the next import
 * finds the case by its body and hands back the same uid.
 *
 * The result is the PROJECT CELL of the registry (`{version, entries}`),
 * which is the shape `resolveMobileUids` reads back and the shape the
 * ATS-201 registry stores. The whole registry (with the other projects'
 * cells) is not rebuilt here: a caller that has one does not want its
 * other projects' cells overwritten.
 */
function mergeMobileRegistry(entries, cases, file) {
  const byUid = new Map();
  for (const e of entries) {
    if (e.uid && !byUid.has(e.uid)) byUid.set(e.uid, e);
  }
  for (const c of cases) {
    if (!c.uid) continue;
    const existing = byUid.get(c.uid);
    const next = {
      uid: c.uid,
      uidSource: c.uidSource,
      titleKey: c.titleKey,
      bodyKey: c.bodyKey,
      file,
      title: c.title,
      line: c.line,
      aliases: [],
    };
    if (existing) {
      if (existing.file !== next.file || existing.title !== next.title) {
        existing.aliases = existing.aliases ?? [];
        if (!existing.aliases.some((a) => a.file === existing.file && a.title === existing.title)) {
          existing.aliases.push({ file: existing.file, title: existing.title });
        }
      }
      existing.uidSource = next.uidSource;
      existing.titleKey = next.titleKey;
      existing.bodyKey = next.bodyKey;
      existing.file = next.file;
      existing.title = next.title;
      existing.line = next.line;
      continue;
    }
    byUid.set(c.uid, next);
  }
  // The pruning is the ATS-201 one: an entry is dropped only when its file
  // was part of THIS import and no resolved case claims its uid.
  const merged = [...byUid.values()];
  return {
    version: 1,
    entries: pruneRegistry(merged, cases, new Set([file])),
  };
}

/** The explicit `@TC-<token>` of a title, or `null`. */
function explicitUidOf(title) {
  const m = /@TC-([a-z0-9][a-z0-9._-]{0,47})/i.exec(String(title ?? ''));
  return m ? `tc-${m[1]}` : null;
}

/** A JSON rendering whose KEY ORDER does not matter. */
function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/* ------------------------------------------------------------------ */
/* The import report                                                   */
/* ------------------------------------------------------------------ */

/**
 * Builds the import report.
 *
 * The report is the deliverable the task names: "用例映射规则与导入报告".
 * It says, for the import as a whole:
 *
 *   * how many cases were produced;
 *   * how many steps were mapped;
 *   * how many steps were NOT mapped, and WHY, with the original text and
 *     the line of every one of them;
 *   * which errors the reader hit.
 *
 * The report is DATA, not a rendering: `formatImportReport()` turns it into
 * text, and the JSON form is what a tool would consume.
 */
export function buildImportReport(imported) {
  const cases = imported?.cases ?? [];
  const unsupported = imported?.unsupported ?? [];
  const errors = imported?.errors ?? [];
  const warnings = imported?.warnings ?? [];
  const mappedSteps = cases.reduce((sum, c) => sum + (c.steps?.length ?? 0), 0);

  const byReason = {};
  for (const step of unsupported) {
    byReason[step.reason] = (byReason[step.reason] ?? 0) + 1;
  }

  return {
    file: imported?.file ?? '',
    syntax: imported?.syntax ?? null,
    appId: imported?.appId ?? null,
    cases: cases.length,
    mappedSteps,
    unsupportedSteps: unsupported.length,
    unsupportedByReason: byReason,
    warnings: warnings.length,
    errors: errors.length,
    // The detail: every unsupported step, with its original text.
    unsupportedSteps_detail: unsupported,
    warnings_detail: warnings,
    errors_detail: errors,
  };
}

/**
 * The text form of the import report.
 *
 * The report has to be READABLE by a person: it is what tells the author
 * of a Flow which of their steps the platform cannot run yet.
 */
export function formatImportReport(report) {
  const lines = [];
  lines.push(`导入报告：${report.file || '(未命名文件)'}`);
  lines.push(`  语法          ：${report.syntax ?? '-'}`);
  lines.push(`  App           ：${report.appId ?? '-'}`);
  lines.push(`  用例数        ：${report.cases}`);
  lines.push(`  已映射步骤数  ：${report.mappedSteps}`);
  lines.push(`  不支持步骤数  ：${report.unsupportedSteps}`);
  lines.push(`  参数告警数    ：${report.warnings}`);
  lines.push(`  读取错误数    ：${report.errors}`);

  if (report.unsupportedSteps) {
    lines.push('');
    lines.push('不支持的步骤（保留原文，未静默丢弃）：');
    for (const step of report.unsupportedSteps_detail ?? []) {
      lines.push(`  第 ${step.line} 行：${step.raw}`);
      lines.push(`      原因：${step.reason} — ${step.reasonText}`);
      if (step.suggestion) {
        lines.push(`      建议：改用 ${step.suggestion}`);
      }
    }
  }

  if (report.warnings) {
    lines.push('');
    lines.push('模型外的参数（已保留原文）：');
    for (const warning of report.warnings_detail ?? []) {
      lines.push(`  第 ${warning.line} 行：${warning.message}`);
    }
  }

  if (report.errors) {
    lines.push('');
    lines.push('读取错误：');
    for (const err of report.errors_detail ?? []) {
      lines.push(`  第 ${err.line} 行：${err.message}`);
    }
  }

  return lines.join('\n');
}
