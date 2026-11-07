/**
 * ATS-602: the mobile Flow PARSER.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A mobile Flow is a declaration of a user journey: "launch the app, tap
 * this element, assert that one is visible, take a screenshot". The platform
 * already has ONE case model (the TestDefinition of ATS-201/ATS-202), and the
 * mobile execution face has to speak it. So the first half of the job is to
 * read a Flow into a **semantic** document -- scenarios, steps, arguments --
 * and the second half (in `mobile-import.mjs`) is to map that document onto
 * the unified TestDefinition.
 *
 * The split matters because the mapping must not depend on the SYNTAX.
 * The design document says it twice: a Flow "of whatever syntax" maps onto
 * the unified model (docs/25 §4.1), and the compatibility judgement is made
 * on SEMANTICS -- "what this step does on the device" -- not on the YAML
 * field names (docs/25 §8.2). So this module answers "what does this file
 * say", and the mapper answers "what does that MEAN".
 *
 * THE TWO SYNTAXES
 * -----------------
 *   `maestro` -- the YAML declaration the design document studied. A header
 *                mapping (`appId:`) and then a list of scenarios, each with a
 *                `name:` and a `steps:` list. This is a RESTRICTED YAML
 *                SUBSET: block mappings, block sequences, scalars and inline
 *                flow sequences are read; anchors, aliases, tags, multi
 *                document features and complex keys are NOT, and a Flow that
 *                uses them is reported as an error instead of being read
 *                half-way.
 *
 *   `linear`  -- a line-oriented declaration with the same semantics and a
 *                different surface syntax:
 *
 *                    app: com.example.app
 *                    scenario: Login with email
 *                      tags: smoke,login
 *                      launch com.example.app
 *                      tap "Login"
 *                      assert visible "Welcome"
 *                      screenshot home
 *
 *                It exists for one reason: the ATS-602 acceptance requires
 *                that SWITCHING THE IMPORT METHOD must not change the UID
 *                of a case that already has one (docs/25 §4.3). A property
 *                that only one syntax can exercise is a property nobody has
 *                measured.
 *
 * WHY THE PARSER IS NOT A YAML LIBRARY
 * ------------------------------------
 * The repository has NO runtime dependency: `package.json` declares none,
 * and the root `package-lock.json` pins an empty dependency set. Adding a
 * YAML library would change the lock file, the CI install and the release
 * manifest for a parser that needs to read a handful of shapes. The
 * restricted reader below is therefore part of the product -- and it is
 * therefore also a place where a hostile Flow could try something. It reads
 * TEXT and never executes anything: a Flow file is data, not code.
 *
 * THE POSITIONS
 * -------------
 * Every step carries the LINE it was declared on, and every scenario carries
 * the line of its declaration. Two things need them:
 *
 *   * the import report points at "file, line, original text" (docs/25 §4.2);
 *   * the position is part of the UID basis (docs/25 §4.3).
 *
 * The line of a step is the line of the SEQUENCE ITEM that carries it -- not
 * the line of the enclosing key. That is the same decision ATS-202 took for
 * the `test(` call (CE-I in docs/23 §4.5): the position has to be the one
 * the reader can reproduce, or the same case gets two identities.
 */

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

/**
 * The Flow syntaxes this parser reads.
 *
 * The syntax is chosen by the FILE EXTENSION (see `detectSyntax`) and can
 * be overridden by the caller. It is NOT a property of the content: the
 * platform does not claim compatibility with any particular tool's syntax
 * (docs/25 §1.2), it reads declarations it can understand and reports the
 * ones it cannot.
 */
export const FLOW_SYNTAX = Object.freeze({
  MAESTRO: 'maestro',
  LINEAR: 'linear',
});

export const FLOW_SYNTAXES = Object.freeze(Object.values(FLOW_SYNTAX));

/**
 * The extension -> syntax mapping.
 *
 * `.yaml` / `.yml` are the YAML declaration; `.flow` is the line-oriented
 * one. A file with any other extension is not a Flow file and is not read.
 */
export const FLOW_EXTENSION_SYNTAX = Object.freeze({
  '.yaml': FLOW_SYNTAX.MAESTRO,
  '.yml': FLOW_SYNTAX.MAESTRO,
  '.flow': FLOW_SYNTAX.LINEAR,
});

/** The syntax of a file, by its extension. `null` when it is not a Flow. */
export function detectSyntax(file) {
  const name = String(file ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return FLOW_EXTENSION_SYNTAX[name.slice(dot)] ?? null;
}

/**
 * The keys of a Maestro step that are OPTIONS, not commands.
 *
 * Maestro lets a step carry metadata next to the command. A metadata key
 * must never be read as the command: `- optional: true` is not a step
 * called "optional".
 */
const STEP_OPTION_KEYS = new Set(['label', 'optional', 'when', 'repeat', 'retry', 'timeout', 'condition']);

/** The keys of a Maestro scenario that hold its steps. */
const SCENARIO_STEP_KEYS = ['steps', 'commands', 'actions'];

/** The keys of a Maestro scenario that hold its name. */
const SCENARIO_NAME_KEYS = ['name', 'title'];

/**
 * The keys of a step that carry its ASSERTION, not a command.
 *
 * `assert` is both a spelling of the `assertVisible` COMMAND and the key
 * that carries the assertion of a step, and the two are told apart by
 * context: a step that names no other command and carries an assertion is
 * the `assert: {visible: X}` form.
 */
const ASSERTION_KEYS = Object.freeze(['assert', 'assertion']);

/**
 * The keys of the EXPLICIT step form: `command:` plus its `arguments:`.
 *
 * They are not command keys, so they must not be mistaken for "the step
 * names two commands".
 */
const EXPLICIT_STEP_KEYS = Object.freeze(['command', 'arguments', 'args']);

/**
 * The keys of a scenario that are METADATA, not steps.
 *
 * A scenario may hold any number of lists; the ones that are neither
 * metadata nor its step list are content the platform does not map, and
 * they are REPORTED (never dropped) -- see `unmappedListsOf`.
 */
const SCENARIO_META_KEYS = Object.freeze([...SCENARIO_NAME_KEYS, 'tags', 'env']);

/**
 * The keys that never hold a step list.
 *
 * A list under one of them is METADATA: the tags of a scenario, the
 * environment of a scenario, the scenarios of a file. They are read by
 * their own rules and they are not content the model fails to map.
 */
const NON_STEP_LIST_KEYS = Object.freeze(new Set([
  ...SCENARIO_META_KEYS,
  'appId', 'app', 'scenarios',
]));

/* ------------------------------------------------------------------ */
/* The public shape                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parses a Flow file into its semantic document.
 *
 * Returns:
 *   {
 *     syntax: 'maestro' | 'linear',
 *     appId:  string | null,      -- the app the flow drives, if it says so
 *     scenarios: [ Scenario ],
 *     errors: [ { line, message } ] -- the problems; an empty list is a
 *                                      clean parse
 *   }
 *
 * A Scenario is:
 *   {
 *     title: string,
 *     line:  number,
 *     tags:  string[],
 *     env:   Record<string, string>,
 *     steps: [ Step ]
 *   }
 *
 * and a Step is:
 *   {
 *     command:    string,   -- the command as the file spells it
 *     args:       object,   -- the arguments as the file spells them
 *     qualifier:  string,   -- the linear syntax's middle word ('visible')
 *     assertion:  object | null,
 *     line:       number,
 *     raw:        string    -- the original text of the step
 *   }
 *
 * A step with no `command` (a malformed one) is reported in `errors` and is
 * NOT put into `scenarios`: a step the reader could not understand must not
 * become a case that runs something unknown.
 *
 * @param {string} text   the file content
 * @param {object} [opts]
 * @param {string} [opts.syntax]  the syntax to read it as
 */
export function parseFlow(text, { syntax = FLOW_SYNTAX.MAESTRO } = {}) {
  if (syntax === FLOW_SYNTAX.LINEAR) return parseLinearFlow(text);
  if (syntax === FLOW_SYNTAX.MAESTRO) return parseMaestroFlow(text);
  return {
    syntax,
    appId: null,
    scenarios: [],
    errors: [{ line: 0, message: `unknown Flow syntax: ${String(syntax)}` }],
  };
}

/* ------------------------------------------------------------------ */
/* The maestro syntax: a restricted YAML subset                        */
/* ------------------------------------------------------------------ */

/**
 * Reads a YAML Flow.
 *
 * The file is split into DOCUMENTS on the `---` separator, because that is
 * how the declaration separates its header (`appId:`) from its body (the
 * scenarios or the steps). Each document is read by the restricted reader.
 *
 * A document is one of three things:
 *
 *   * a HEADER   -- a mapping that holds only metadata (`appId`, the title
 *     of the file, `tags`, `env`). It declares the app the file drives and
 *     it may title the file's single scenario. It is NOT a case of its
 *     own: a header that produced a case would give the file a second,
 *     empty case next to the real one.
 *   * a SCENARIO -- a mapping that holds a step list, or an entry of the
 *     `scenarios:` list.
 *   * a STEP LIST -- a list of steps. The whole file is then one scenario.
 *
 * A list that holds no scenario at all is a step list; a list that holds
 * nothing but scenarios is the scenario list; a list that mixes the two is
 * an error (the file is one or the other).
 */
export function parseMaestroFlow(text) {
  const src = String(text ?? '');
  const errors = [];
  const documents = splitDocuments(src);
  const parsed = [];

  for (const doc of documents) {
    if (!doc.tokens.length) continue;
    try {
      const read = parseYamlDocument(doc.tokens, doc.firstLine);
      parsed.push(read);
    } catch (err) {
      errors.push({
        line: err.line ?? doc.firstLine,
        message: err.message ?? String(err),
      });
    }
  }

  let appId = null;
  let headerTitle = null;
  const scenarios = [];
  // The lists the model does not map. They are REPORTED, never dropped.
  const unmapped = [];

  // Every NODE of every document is read. A document that holds more than
  // one node is malformed, and the malformation is reported -- but the
  // nodes are all read, so nothing is lost silently.
  for (const read of parsed) {
    if (read.boundary) {
      errors.push({ line: read.boundary.line, message: read.boundary.message });
    }
    for (const node of read.nodes ?? []) {
      if (isMapping(node)) {
        if (typeof node.appId === 'string' && node.appId) appId = node.appId;
        if (!hasStepList(node)) {
          const name = scenarioNameOf(node);
          if (name !== null && headerTitle === null) headerTitle = name;
          unmappedListsOf(node, read, { knownKeys: new Set(['scenarios']), scope: 'header', out: unmapped });
        }
      }
    }
  }

  for (const read of parsed) {
    for (const value of read.nodes ?? []) {
      if (Array.isArray(value)) {
        const lines = read.seqLinesOf(value) ?? [];
        const raws = read.seqRawOf(value) ?? [];
        const items = value.map((item, index) => ({ item, line: lines[index] ?? read.line, raw: raws[index] ?? null }));
        const scenarioItems = items.filter((it) => isScenarioMapping(it.item));
        if (scenarioItems.length === 0) {
          // The list is a list of STEPS: the whole file is one scenario.
          scenarios.push({
            title: headerTitle,
            line: read.line,
            tags: [],
            env: {},
            steps: stepsFromList(items, errors),
          });
        } else if (scenarioItems.length === items.length) {
          for (const it of items) {
            scenarios.push(scenarioFromMapping(it.item, scenarioNameOf(it.item), read, errors, unmapped));
          }
        } else {
          errors.push({
            line: read.line,
            message: 'the list mixes scenarios and steps; a Flow file is either a list of scenarios or a list of steps',
          });
        }
        continue;
      }
      if (!isMapping(value)) continue;
      if (Array.isArray(value.scenarios)) {
        const lines = read.seqLinesOf(value.scenarios) ?? [];
        const raws = read.seqRawOf(value.scenarios) ?? [];
        value.scenarios.forEach((item, index) => {
          if (!isMapping(item)) {
            errors.push({ line: lines[index] ?? read.line, message: 'a scenario entry is not a mapping' });
            return;
          }
          const itemName = scenarioNameOf(item);
          if (itemName === null) {
            errors.push({ line: lines[index] ?? read.line, message: 'a scenario entry has no name' });
            return;
          }
          scenarios.push(scenarioFromMapping(item, itemName, read, errors, unmapped));
        });
        continue;
      }
      if (hasStepList(value)) {
        // A mapping that holds steps IS a scenario.
        scenarios.push(scenarioFromMapping(value, scenarioNameOf(value), read, errors, unmapped));
        continue;
      }
      // A header: it was read in the first pass.
    }
  }

  if (!scenarios.length && !errors.length) {
    errors.push({ line: 0, message: 'the Flow declares no scenario' });
  }

  return { syntax: FLOW_SYNTAX.MAESTRO, appId, scenarios, errors, unmapped };
}

/** True when the value is a mapping (and not a list). */
function isMapping(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** True when the mapping holds a list of steps. */
function hasStepList(mapping) {
  return SCENARIO_STEP_KEYS.some((key) => Array.isArray(mapping[key]));
}

/**
 * The lists of a mapping that the unified model does not map.
 *
 * A scenario may hold several lists: one is its step list, the others
 * (`setup`, `onFlowStart`, a second `commands:` list, ...) are content the
 * platform does not map. Every one of their ITEMS is reported with its
 * original text -- a step the platform cannot use must not disappear
 * without a trace.
 */
function unmappedListsOf(mapping, read, { knownKeys, scope, out }) {
  for (const [key, value] of Object.entries(mapping)) {
    if (!Array.isArray(value)) continue;
    if (knownKeys.has(key)) continue;
    // The METADATA lists -- the tags of a scenario, the environment of a
    // scenario -- are read by their own rules. They are not content the
    // model fails to map.
    if (NON_STEP_LIST_KEYS.has(key)) continue;
    const lines = read?.seqLinesOf?.(value) ?? [];
    const raws = read?.seqRawOf?.(value) ?? [];
    value.forEach((item, index) => {
      out.push({
        scope,
        key,
        line: lines[index] ?? read?.line ?? 0,
        raw: raws[index] ?? null,
      });
    });
  }
}

/**
 * The name of a scenario mapping, or `null` when it has none.
 *
 * A scenario is a mapping that carries a name. A mapping without a name is
 * a header, not a scenario.
 */
function scenarioNameOf(mapping) {
  for (const key of SCENARIO_NAME_KEYS) {
    const value = mapping[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** The title of a top-level mapping that names a single scenario. */
function headerTitleOf(parsed) {
  for (const read of parsed) {
    const value = read.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const name = scenarioNameOf(value);
      if (name !== null) return name;
    }
  }
  return null;
}

/** True when the value is a mapping that names a scenario. */
function isScenarioMapping(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && scenarioNameOf(value) !== null);
}

/**
 * Builds a scenario from its mapping.
 *
 * The steps are read from the first of `steps` / `commands` / `actions` that
 * is present. The line of the scenario is the line of its NAME key when the
 * reader knows it, so that the position points at the declaration rather
 * than at the file's first line.
 *
 * A scenario may hold MORE THAN ONE list. Only the first one is the step
 * list; the others (`setup:`, a second `commands:`, ...) are content the
 * unified model does not map, and every one of their items is REPORTED --
 * a step the platform cannot use must not disappear without a trace.
 */
function scenarioFromMapping(mapping, title, read, errors, unmapped = null) {
  // The line of the scenario is the line of its NAME key, so that the
  // position points at the declaration rather than at the file's first line.
  const keyLines = read?.keyLinesOf?.(mapping) ?? null;
  const nameKey = SCENARIO_NAME_KEYS.find((k) => typeof mapping[k] === 'string');
  const line = (keyLines && nameKey && keyLines[nameKey]) || read?.line || 0;

  const tags = readTags(mapping);
  const env = readEnv(mapping);

  let steps = [];
  const stepKey = SCENARIO_STEP_KEYS.find((key) => Array.isArray(mapping[key]));
  if (stepKey) {
    const list = mapping[stepKey];
    const lines = read?.seqLinesOf?.(list) ?? [];
    const raws = read?.seqRawOf?.(list) ?? [];
    const items = list.map((item, index) => ({ item, line: lines[index] ?? line, raw: raws[index] ?? null }));
    steps = stepsFromList(items, errors);
  }
  // The OTHER lists of the scenario are reported.
  if (unmapped) {
    unmappedListsOf(mapping, read, { knownKeys: new Set([stepKey].filter(Boolean)), scope: 'scenario', out: unmapped });
  }

  return { title, line, tags, env, steps };
}

/** The `tags` of a scenario. A list or a comma separated string. */
function readTags(mapping) {
  const raw = mapping.tags;
  if (Array.isArray(raw)) return raw.filter((t) => t !== null && t !== undefined).map(String);
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

/** The `env` of a scenario: a flat mapping of names to values. */
function readEnv(mapping) {
  const raw = mapping.env;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    out[String(k)] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/**
 * Reads a list of steps.
 *
 * A step is one of:
 *   * a scalar            -- `- launchApp`
 *   * a mapping           -- `- tapOn: "Login"` or `- command: tapOn`
 *   * a mapping with an `arguments` block and a `command` key
 *
 * Every step keeps the ORIGINAL text of its line, because that text is what
 * the import report quotes when the step cannot be mapped (docs/25 §4.2).
 */
function stepsFromList(items, errors) {
  const steps = [];
  for (const { item, line, raw } of items) {
    if (item === null || item === undefined) {
      errors.push({ line, message: 'an empty step' });
      continue;
    }
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      const command = String(item).trim();
      if (!command) {
        errors.push({ line, message: 'an empty step' });
        continue;
      }
      steps.push({ command, args: {}, qualifier: null, assertion: null, options: null, line, raw: raw ?? String(item) });
      continue;
    }
    if (Array.isArray(item) || typeof item !== 'object') {
      errors.push({ line, message: 'a step is not a command' });
      continue;
    }
    const step = stepFromMapping(item, line, raw, errors);
    if (step) steps.push(step);
  }
  return steps;
}

/**
 * Reads one step out of a mapping.
 *
 * Two shapes are recognised:
 *   * `- command: tapOn` with an `arguments:` block (the explicit form);
 *   * `- tapOn: "Login"` (the short form: the first key that is not a step
 *     option names the command).
 *
 * A step that names MORE THAN ONE command is reported. The short form
 * takes the first command key, and the others would be silently lost --
 * and a step that says two things is a step the platform does not
 * understand, so it is reported with its original text rather than
 * half-read.
 */
function stepFromMapping(mapping, line, rawText, errors) {
  // The ORIGINAL text of the step, when the reader knows it. A step that
  // the reader REBUILDS is a fallback: the report has to show what the
  // author wrote, not what the parser made of it.
  const raw = rawText ?? buildRaw(mapping);

  if (typeof mapping.command === 'string' && mapping.command.trim()) {
    const args = readStepArguments(mapping.arguments ?? mapping.args);
    return {
      command: mapping.command.trim(),
      args,
      qualifier: null,
      assertion: readAssertion(mapping.assert ?? mapping.assertion),
      options: readStepOptions(mapping),
      line,
      raw,
    };
  }

  // The COMMAND KEYS of the step: the keys that are neither an option, nor
  // an assertion, nor part of the explicit form.
  const commandKeys = Object.keys(mapping).filter(
    (key) => !STEP_OPTION_KEYS.has(key)
      && !ASSERTION_KEYS.includes(key)
      && !EXPLICIT_STEP_KEYS.includes(key),
  );

  if (commandKeys.length > 1) {
    // The step names two commands. Reading the first one and dropping the
    // second would LOSE the second silently -- the exact failure the task
    // forbids. The step is reported as one that names no single command.
    errors.push({
      line,
      message: `the step names more than one command (${commandKeys.join(', ')}); a step must name exactly one`,
    });
    return {
      command: '',
      args: {},
      qualifier: null,
      assertion: readAssertion(mapping.assert ?? mapping.assertion),
      options: readStepOptions(mapping),
      line,
      raw,
    };
  }

  if (commandKeys.length === 1) {
    const key = commandKeys[0];
    const args = readStepArguments(mapping[key]);
    return {
      command: key,
      args,
      qualifier: null,
      assertion: readAssertion(mapping.assert ?? mapping.assertion),
      options: readStepOptions(mapping),
      line,
      raw,
    };
  }

  // The step carries only OPTIONS and names no command. It is NOT a read
  // error: the file was read fine. It is a step the mapper cannot use, so
  // it is handed on with an empty command -- the mapper reports it as an
  // unsupported step, keeping its original text. A step that is dropped
  // here would vanish from the report, and the report is where the author
  // of the Flow learns that the step was not understood.
  return {
    command: '',
    args: {},
    qualifier: null,
    assertion: readAssertion(mapping.assert ?? mapping.assertion),
    options: readStepOptions(mapping),
    line,
    raw,
  };
}

/**
 * The OPTIONS of a step.
 *
 * `optional`, `when`, `timeout` and the rest are not commands: they say
 * under which conditions the step runs and how long it may take. The
 * unified mobile case model has no place for them, so they are KEPT (they
 * are part of what the author declared) and the mapper reports them.
 */
function readStepOptions(mapping) {
  const out = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (!STEP_OPTION_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'object' ? JSON.stringify(value) : value;
  }
  return Object.keys(out).length ? out : null;
}

/** The arguments of a step: a mapping, or a scalar under one name. */
function readStepArguments(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      out[k] = typeof v === 'object' ? JSON.stringify(v) : v;
    }
    return out;
  }
  return { value };
}

/**
 * The assertion a step carries.
 *
 * The shape is `{visible: "Welcome"}` or `{notVisible: "Welcome"}`. The
 * assertion is DATA attached to the step; the mapper decides what it means
 * (docs/25 §4.1: a step's assertion is `TestStep.assertion`).
 */
function readAssertion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The original text of a step.
 *
 * The reader does not keep the source lines, so the text is rebuilt from the
 * parsed mapping. It is a faithful rendering of the DECLARED step, not the
 * original bytes; the import report quotes it as "the step as declared".
 */
function buildRaw(mapping) {
  const parts = [];
  for (const [key, value] of Object.entries(mapping)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      parts.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.join(', ');
}

/* ------------------------------------------------------------------ */
/* The linear syntax                                                   */
/* ------------------------------------------------------------------ */

/**
 * Reads a line-oriented Flow.
 *
 * The grammar is small and explicit:
 *
 *   app: <id>              -- the app the flow drives (once, at the top)
 *   scenario: <title>      -- starts a scenario
 *     tags: a,b            -- the tags of the scenario
 *     env:                 -- the environment of the scenario
 *       NAME: value
 *     <verb> [args...]     -- a step
 *
 * A step line is `<verb> [qualifier] [args...]`, where the args are
 * space separated and a quoted argument keeps its spaces.
 */
export function parseLinearFlow(text) {
  const src = String(text ?? '');
  const errors = [];
  const lines = src.split(/\r?\n/);

  let appId = null;
  const scenarios = [];
  let current = null;
  let inEnv = false;
  // The indent of the `env:` KEY. The environment block is the lines that
  // are indented MORE than the key that opened it -- and only those. A
  // step line that follows the block at the scenario's own indent is a
  // STEP, not another environment variable.
  //
  // This is the fix for the case where a step line happened to look like a
  // `key: value` line: `tap Settings: General` is a step that taps
  // "Settings", and without the indent rule it was read as an environment
  // variable named "tap Settings" -- so the step disappeared from the
  // import without a trace.
  let envIndent = -1;

  const startScenario = (title, line) => {
    current = { title, line, tags: [], env: {}, steps: [] };
    scenarios.push(current);
    inEnv = false;
    envIndent = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    const stripped = stripComment(rawLine);
    if (!stripped.trim()) continue;
    const indent = stripped.length - stripped.trimStart().length;
    const text = stripped.trim();

    const header = splitKey(text);
    if (header && indent === 0) {
      if (header.key === 'app') {
        appId = header.rest;
        continue;
      }
      if (header.key === 'scenario' || header.key === 'title') {
        startScenario(header.rest, lineNo);
        continue;
      }
    }

    if (!current) {
      errors.push({ line: lineNo, message: 'a step appears before any scenario' });
      continue;
    }

    // The environment block ends as soon as a line is not indented more
    // than the `env:` key. Everything after that is a step again.
    if (inEnv && indent <= envIndent) {
      inEnv = false;
      envIndent = -1;
    }

    if (indent > 0 && header && header.key === 'tags' && header.rest) {
      current.tags = header.rest.split(',').map((t) => t.trim()).filter(Boolean);
      continue;
    }
    if (indent > 0 && header && header.key === 'env' && !header.rest) {
      inEnv = true;
      envIndent = indent;
      continue;
    }
    if (inEnv && indent > envIndent && header) {
      // The VALUE of an environment variable is read like any other
      // scalar: a quoted value keeps its spaces but loses its quotes.
      current.env[header.key] = stripQuotes(header.rest);
      continue;
    }
    if (indent > 0 && header && (header.key === 'steps' || header.key === 'commands')) {
      // `steps: launch, tap` -- a comma separated inline list of steps.
      const list = header.rest.split(',').map((s) => s.trim()).filter(Boolean);
      for (const one of list) {
        current.steps.push(stepFromLine(one, lineNo, one, errors));
      }
      continue;
    }

    const step = stepFromLine(text, lineNo, text, errors);
    if (step) current.steps.push(step);
  }

  if (!scenarios.length && !errors.length) {
    errors.push({ line: 0, message: 'the Flow declares no scenario' });
  }

  return { syntax: FLOW_SYNTAX.LINEAR, appId, scenarios, errors, unmapped: [] };
}

/**
 * The qualifier words a linear step may carry, per verb.
 *
 * A two word verb (`assert visible`, `tap on`) is written as two words in
 * the linear syntax, and the SECOND word is a qualifier, not an argument.
 * The table is part of the linear SYNTAX's grammar, so it belongs to the
 * parser: the mapper sees a command and a qualifier, whatever syntax the
 * step was written in.
 */
const LINEAR_QUALIFIERS = Object.freeze({
  assert: Object.freeze(['notVisible', 'visible']),
  tap: Object.freeze(['on']),
});

/**
 * Reads one step out of a line.
 *
 * The line is split into a verb, an optional qualifier and the arguments.
 *
 * A step that takes MORE arguments than it has names for is reported: the
 * extra argument would otherwise overwrite the first one (`tap "First"
 * "Second"` would tap "Second"), and a step that says two things is a
 * step the platform does not understand.
 */
function stepFromLine(text, line, raw, errors) {
  const parts = splitWords(text);
  // A step that names nothing -- an empty line, or a pair of quotes -- is
  // not a command. It is reported, not turned into a step called `""`.
  if (!parts.length || (parts.length === 1 && stripQuotes(parts[0]) === '')) {
    errors.push({ line, message: 'an empty step' });
    return null;
  }
  const verb = parts[0];
  let qualifier = null;
  let args = parts.slice(1);
  const qualifiers = LINEAR_QUALIFIERS[verb] ?? [];
  if (args.length && qualifiers.includes(args[0])) {
    qualifier = args[0];
    args = args.slice(1);
  }
  const out = {};
  const extra = [];
  args.forEach((arg, index) => {
    const value = (arg.startsWith('"') || arg.startsWith("'")) ? stripQuotes(arg) : arg;
    let name = primaryArgOf(verb, qualifier, index);
    if (out[name] !== undefined) {
      // The name is taken: this argument would OVERWRITE the first one.
      // The extra argument is KEPT under a name of its own -- it is
      // declared content, and dropping it would lose it without a trace.
      // The mapper reports it as an argument outside the model.
      name = `arg${index}`;
      let suffix = 2;
      while (out[name] !== undefined) name = `arg${index}_${suffix++}`;
      extra.push(arg);
    }
    out[name] = value;
  });
  // The extra arguments are reported by the MAPPER, not here: the reader
  // does not know the model, and an argument outside the model is the
  // mapper's business.
  return { command: verb, args: out, qualifier, assertion: null, options: null, line, raw };
}

/**
 * The name of the argument at a position.
 *
 * A step that takes one argument names it (`tap "Login"` -> `text`). A step
 * that takes several names them by position (`assert visible "Welcome"` ->
 * `text`). The names are the ones the maestro syntax uses, so that the two
 * syntaxes produce the SAME arguments for the same step.
 */
function primaryArgOf(verb, qualifier, index) {
  if (verb === 'assert') return 'text';
  if (verb === 'screenshot' || verb === 'record') return 'name';
  if (verb === 'logs') return 'path';
  if (verb === 'launch') return 'appId';
  if (verb === 'tap') return 'text';
  return index === 0 ? 'value' : `arg${index}`;
}

/**
 * Splits a line into words, keeping a quoted word together.
 */
function splitWords(text) {
  const out = [];
  let current = '';
  let quote = null;
  for (const ch of String(text ?? '')) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) { out.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** Removes the quotes of a quoted word. */
function stripQuotes(text) {
  const s = String(text ?? '');
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* The restricted YAML reader                                          */
/* ------------------------------------------------------------------ */

/**
 * Splits a source into documents on the `---` separator.
 *
 * Every token keeps the ORIGINAL text of its line (`raw`), so that a step
 * can quote what the author actually wrote. The import report has to show
 * the ORIGINAL TEXT of a step it could not map (docs/25 §4.2), and a text
 * that is REBUILT from the parsed value is not the original: it has lost
 * the quotes, the comments and the spelling.
 */
function splitDocuments(src) {
  const docs = [];
  let tokens = [];
  let firstLine = 1;
  const lines = src.split(/\r?\n/);
  let lineNo = 0;
  for (const raw of lines) {
    lineNo += 1;
    const stripped = stripComment(raw);
    if (!stripped.trim()) continue;
    if (stripped.trim() === '---') {
      docs.push({ tokens, firstLine });
      tokens = [];
      firstLine = lineNo + 1;
      continue;
    }
    const indent = stripped.length - stripped.trimStart().length;
    tokens.push({ indent, text: stripped.trim(), raw: raw.trim(), lineNo });
  }
  docs.push({ tokens, firstLine });
  return docs;
}

/**
 * Reads one YAML document.
 *
 * The reader understands block mappings, block sequences, scalars, inline
 * flow sequences and inline flow mappings. It does NOT understand anchors,
 * aliases, tags or complex keys -- a document that uses them is an ERROR,
 * not a half-read document.
 *
 * The positions are returned alongside the value:
 *   * `seqLines` -- the line of every element of every sequence;
 *   * `keyLines` -- the line of every key of every mapping;
 *   * `seqLinesOf` / `keyLinesOf` -- the same, addressed by the value.
 */
function parseYamlDocument(tokens, firstLine) {
  const positions = new WeakMap();
  const index = { i: 0 };

  // THE DOCUMENT IS READ TO THE END.
  //
  // A reader that stops at the first structure it understands reads HALF a
  // document: the rest of it is silently gone, and the case it declared
  // never appears. That is exactly the failure the task forbids ("不读
  // 一半"): a Flow that is not fully understood has to be REPORTED, not
  // half-imported.
  //
  // A document normally holds ONE top-level node. A malformed one holds
  // more: a stray key in the middle of a scenario list, for instance. The
  // reader reads every node it can, REPORTS the boundary, and keeps the
  // nodes -- so a malformed file loses nothing silently, and the report
  // says where the malformation is.
  const nodes = [];
  let boundary = null;
  while (index.i < tokens.length) {
    const start = index.i;
    const token = tokens[index.i];
    if (nodes.length && !boundary) {
      boundary = {
        line: token.lineNo,
        message: `the document holds more than one top-level node: "${token.text}" starts a new one`,
      };
    }
    const node = readNode(tokens, index, token.indent, positions);
    if (index.i === start) {
      // No progress: the token cannot start a node at all.
      throw yamlError(token, `not a mapping entry: ${token.text}`);
    }
    nodes.push(node);
  }

  // The positions are looked up BY THE VALUE ITSELF, so that a nested list
  // is addressed by the array the caller holds (`value.scenarios`), not by a
  // position that a parent mapping would have to keep in step with it.
  const seqLinesOf = (arr) => (arr && typeof arr === 'object' ? positions.get(arr)?.seqLines ?? null : null);
  const keyLinesOf = (map) => (map && typeof map === 'object' ? positions.get(map)?.keyLines ?? null : null);
  // The ORIGINAL text of every element of a sequence. The import report
  // quotes it, so a step the platform cannot map is shown as the author
  // wrote it (docs/25 §4.2).
  const seqRawOf = (arr) => (arr && typeof arr === 'object' ? positions.get(arr)?.seqRaw ?? null : null);

  // The top level position: the line of the first token of the document.
  const top = { line: tokens.length ? tokens[0].lineNo : firstLine };

  return {
    nodes,
    boundary,
    value: nodes.length === 1 ? nodes[0] : (nodes.length ? nodes : null),
    line: top.line,
    seqLines: seqLinesOf(nodes[0]),
    keyLines: keyLinesOf(nodes[0]),
    seqLinesOf,
    keyLinesOf,
    seqRawOf,
  };
}

/**
 * Reads the node that starts at `index.i`.
 *
 * A node is a SEQUENCE when its first token is a `- ` item, and a MAPPING
 * otherwise. The indent of the node is the indent of its first token.
 */
function readNode(tokens, index, indent, positions) {
  if (index.i >= tokens.length) return null;
  const token = tokens[index.i];
  if (token.indent !== indent) {
    throw yamlError(token, `unexpected indentation (expected ${indent}, found ${token.indent})`);
  }
  if (isSequenceItem(token.text)) return readSequence(tokens, index, indent, positions);
  return readMapping(tokens, index, indent, positions);
}

/**
 * Reads a block mapping.
 *
 * A key whose value is empty takes the block that follows it. A block
 * sequence may sit at the key's own indent (that is legal YAML) or deeper;
 * both are read.
 */
function readMapping(tokens, index, indent, positions) {
  const map = {};
  const keyLines = {};
  positions.set(map, { keyLines, seqLines: null });

  while (index.i < tokens.length) {
    const token = tokens[index.i];
    if (token.indent < indent) break;
    if (token.indent > indent) {
      throw yamlError(token, `unexpected indentation (expected ${indent}, found ${token.indent})`);
    }
    if (isSequenceItem(token.text)) break;

    const entry = splitKey(token.text);
    if (!entry) {
      throw yamlError(token, `not a mapping entry: ${token.text}`);
    }
    const { key, rest } = entry;
    if (keyLines[key] !== undefined) {
      throw yamlError(token, `the key "${key}" appears twice in the same mapping`);
    }
    keyLines[key] = token.lineNo;

    if (rest === '') {
      const next = tokens[index.i + 1];
      if (next && (next.indent > indent || (next.indent === indent && isSequenceItem(next.text)))) {
        const childIndent = next.indent;
        // The index moves past the KEY before the child is read: the child
        // is what follows the key, not the key itself.
        index.i += 1;
        const child = readNode(tokens, index, childIndent, positions);
        map[key] = child;
        continue;
      }
      map[key] = null;
      index.i += 1;
      continue;
    }
    map[key] = readScalar(rest, token);
    index.i += 1;
  }
  return map;
}

/**
 * Reads a block sequence.
 *
 * An item whose content is a mapping entry (`- name: x`) continues on the
 * following lines at the column the content starts in; that is why the item
 * is read as a MAPPING whose first token is the item's own content.
 */
function readSequence(tokens, index, indent, positions) {
  const list = [];
  const seqLines = [];
  const seqRaw = [];
  positions.set(list, { keyLines: null, seqLines, seqRaw });

  while (index.i < tokens.length) {
    const token = tokens[index.i];
    if (token.indent < indent) break;
    if (token.indent > indent) {
      throw yamlError(token, `unexpected indentation (expected ${indent}, found ${token.indent})`);
    }
    if (!isSequenceItem(token.text)) break;

    const content = token.text.slice(1).trimStart();
    const contentColumn = token.indent + (token.text.length - content.length);

    if (content === '') {
      const next = tokens[index.i + 1];
      if (next && next.indent > indent) {
        const child = readNode(tokens, index, next.indent, positions);
        list.push(child);
        seqLines.push(next.lineNo);
        seqRaw.push(next.raw);
        continue;
      }
      list.push(null);
      seqLines.push(token.lineNo);
      seqRaw.push(token.raw);
      index.i += 1;
      continue;
    }

    const entry = splitKey(content);
    if (entry) {
      // The item is a mapping that starts on the item's own line. The item's
      // content is re-read as the first line of a mapping at the content's
      // column, so that the continuation lines join it.
      //
      // The token is restored afterwards -- the reader may have written over
      // it -- but the INDEX is NOT reset: the item's content has been
      // consumed and the next item starts after it.
      const savedIndex = index.i;
      const saved = tokens[savedIndex];
      tokens[savedIndex] = { indent: contentColumn, text: content, raw: saved.raw, lineNo: saved.lineNo };
      let value;
      try {
        value = readMapping(tokens, index, contentColumn, positions);
      } finally {
        tokens[savedIndex] = saved;
      }
      list.push(value);
      seqLines.push(saved.lineNo);
      seqRaw.push(saved.raw);
      continue;
    }

    list.push(readScalar(content, token));
    seqLines.push(token.lineNo);
    seqRaw.push(token.raw);
    index.i += 1;
  }
  return list;
}

/**
 * Reads a scalar.
 *
 * A quoted scalar is read literally and its escapes are decoded. A plain
 * scalar is read as text, except for the words that YAML gives a type to.
 */
function readScalar(text, token) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.startsWith('"')) {
    const end = findQuoteEnd(trimmed, '"');
    if (end < 0) throw yamlError(token, 'an unterminated double-quoted scalar');
    return decodeDoubleQuoted(trimmed.slice(1, end));
  }
  if (trimmed.startsWith("'")) {
    const end = findQuoteEnd(trimmed, "'");
    if (end < 0) throw yamlError(token, 'an unterminated single-quoted scalar');
    return trimmed.slice(1, end).replace(/''/g, "'");
  }
  if (trimmed.startsWith('[')) {
    const end = findBracketEnd(trimmed, '[', ']');
    if (end < 0) throw yamlError(token, 'an unterminated inline sequence');
    const inner = trimmed.slice(1, end).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map((part) => readScalar(part, token));
  }
  if (trimmed.startsWith('{')) {
    const end = findBracketEnd(trimmed, '{', '}');
    if (end < 0) throw yamlError(token, 'an unterminated inline mapping');
    const inner = trimmed.slice(1, end).trim();
    const out = {};
    if (!inner) return out;
    for (const part of splitTopLevel(inner)) {
      const entry = splitKey(part.trim());
      if (!entry) throw yamlError(token, `not a mapping entry: ${part.trim()}`);
      out[entry.key] = readScalar(entry.rest, token);
    }
    return out;
  }
  if (trimmed.startsWith('&') || trimmed.startsWith('*') || trimmed.startsWith('!')) {
    throw yamlError(token, 'anchors, aliases and tags are not supported');
  }
  if (trimmed === 'true' || trimmed === 'True') return true;
  if (trimmed === 'false' || trimmed === 'False') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d*\.\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** True when the text opens a block sequence item. */
function isSequenceItem(text) {
  return text === '-' || text.startsWith('- ');
}

/**
 * Splits a mapping entry into its key and its value.
 *
 * The `:` must be followed by a space or end the line, and it must not be
 * inside a quoted scalar. A plain word that contains a colon (`a:b`) is a
 * scalar, not a mapping.
 *
 * Returns `null` when the text is NOT a mapping entry. That null is the
 * whole point of this function: a caller that asks "is this line a
 * `key: value` line?" must be able to tell the two apart. A caller that
 * received `{key: null}` instead would read "this line has a key, and the
 * key is nothing" -- which is TRUTHY, and which once made the linear
 * reader swallow every step that followed an `env:` block into the
 * environment (the env block was entered by a `key: value` line, and every
 * later line was swallowed because the "no key" result was truthy).
 */
function splitKey(text) {
  const src = String(text ?? '');
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ':' && (i + 1 === src.length || /\s/.test(src[i + 1]))) {
      return { key: readScalar(src.slice(0, i).trim(), { lineNo: 0 }), rest: src.slice(i + 1).trim() };
    }
  }
  return null;
}

/** The offset of the closing quote of a quoted scalar. */
function findQuoteEnd(text, quote) {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\' && quote === '"') { i += 1; continue; }
    if (text[i] === quote) return i;
  }
  return -1;
}

/** The offset of the closing bracket of an inline collection. */
function findBracketEnd(text, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === open) depth += 1;
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits a comma separated list, ignoring commas inside quotes. */
function splitTopLevel(text) {
  const out = [];
  let current = '';
  let quote = null;
  for (const ch of String(text ?? '')) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** Decodes the escapes of a double-quoted scalar. */
function decodeDoubleQuoted(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (whole, esc) => {
    if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      default: return esc;
    }
  });
}

/**
 * Removes the comment of a line.
 *
 * A `#` starts a comment when it is at the start of the line or preceded by
 * a space, and when it is not inside a quoted scalar.
 */
function stripComment(line) {
  const src = String(line ?? '');
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && quote === '"') { out += src[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(src[i - 1]))) break;
    out += ch;
  }
  return out;
}

/** An error that carries the line it happened on. */
function yamlError(token, message) {
  const err = new Error(message);
  err.line = token?.lineNo ?? 0;
  return err;
}
