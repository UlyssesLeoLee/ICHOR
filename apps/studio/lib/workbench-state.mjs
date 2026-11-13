/**
 * ATS-111 -- the WORKBENCH STATE MODEL.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The acceptance criterion of this task is one sentence:
 *
 *   「空列表/失败/取消/加载态均可辨识；核心操作可键盘完成」
 *
 *   ("empty list / failure / cancel / loading states must each be
 *    distinguishable; the core operations must be completable with the
 *    keyboard")
 *
 * That sentence has two halves, and both of them are requirements about
 * HONESTY rather than about pixels:
 *
 *   1. FOUR STATES MUST NOT LOOK ALIKE. A workbench that shows "nothing
 *      here" for an empty list, for a request that FAILED, for a request
 *      the user CANCELLED and for a request that is still LOADING cannot
 *      be acted on: the reader cannot tell "there is nothing to do here"
 *      from "we could not find out" from "you stopped this" from "wait".
 *      The four are different facts about the world, so they get four
 *      different, NAMED, distinguishable presentations.
 *
 *   2. THE CORE FLOW MUST BE REACHABLE WITHOUT A MOUSE. Not "the button
 *      has a tabindex" -- the reader must be able to WALK the core flow:
 *      the focus order must be the reading order, the focus must be
 *      VISIBLE, Escape must cancel what is in flight, and Enter must
 *      submit what is on screen.
 *
 * This module holds the MODEL of both halves, so that:
 *
 *   - the Next workbench (apps/studio/app/page.tsx) renders from it, and
 *   - the unit tests (tests/workbench-state.test.mjs) can assert on it
 *     WITHOUT a browser.
 *
 * WHY THE MODEL IS SEPARATE FROM THE VIEW
 * ---------------------------------------
 * The view is React, and React is not a test dependency of this
 * repository (the test suite is `node --test` on plain ES modules -- see
 * package.json). A model that lives in a plain module can be asserted
 * exhaustively by the unit tests, and the view can only be checked by
 * actually driving a browser -- which the ST probe does
 * (tools/ats111-probes/st-ats111.mjs).
 *
 * THE FOUR STATES ARE A CLOSED SET
 * -------------------------------
 * `deriveWorkbenchState` maps a request's outcome onto EXACTLY ONE of
 * four states. The mapping is total and deterministic: every possible
 * input yields one of the four, and the four are mutually exclusive. A
 * fifth "mystery" state is deliberately NOT provided -- an unrecognised
 * outcome is reported as `error` rather than being silently swallowed,
 * because "we could not tell" is a failure, not a fifth kind of success.
 *
 * THE STATES ARE DISTINGUISHED BY MORE THAN A COLOUR
 * ---------------------------------------------------
 * docs/05-UI-UX.md §4 requires that a state is not conveyed by colour
 * alone. So each state carries a TEXT label, a distinct ROLE/token, an
 * ARIA live-region politeness, and an explicit "what can the reader do
 * next" hint. The tests assert on those, not on a colour.
 */

/**
 * The four states of a workbench panel. The names are the contract.
 *
 * @typedef {'empty'|'error'|'cancelled'|'loading'} WorkbenchStateKind
 */

/**
 * @typedef {object} WorkbenchState
 * @property {WorkbenchStateKind} kind      the state, exactly one of the four
 * @property {string} label                 the Chinese label shown to the reader
 * @property {string} detail                what the reader is told, in words
 * @property {string} hint                  what the reader can DO next
 * @property {string} role                  the ARIA role of the container
 * @property {string} ariaLive              the live-region politeness ('off'|'polite'|'assertive')
 * @property {boolean} busy                 whether the panel is working right now
 * @property {boolean} actionable           whether an action is offered right now
 * @property {string} token                 a stable machine token (used by the tests and by the DOM)
 */

/**
 * The four states, spelled out.
 *
 * `label` and `detail` are what the reader sees; `hint` is what the
 * reader can do. They are DIFFERENT for every state -- that is the point
 * of the exercise: a reader must be able to tell the four apart from the
 * text alone, without relying on a colour or an icon.
 */
export const WORKBENCH_STATES = Object.freeze({
  empty: Object.freeze({
    kind: 'empty',
    label: '暂无内容',
    detail: '这里还没有数据。',
    hint: '选择一个项目或调整筛选条件，或运行一次测试来生成内容。',
    role: 'status',
    ariaLive: 'polite',
    busy: false,
    actionable: true,
    token: 'workbench-state-empty',
  }),
  error: Object.freeze({
    kind: 'error',
    label: '加载失败',
    detail: '数据没能加载出来。',
    hint: '重试；如果仍然失败，请检查本地执行服务是否在运行。',
    role: 'alert',
    ariaLive: 'assertive',
    busy: false,
    actionable: true,
    token: 'workbench-state-error',
  }),
  cancelled: Object.freeze({
    kind: 'cancelled',
    label: '已取消',
    detail: '这次加载被取消了，没有拿到数据。',
    hint: '重新加载以继续。取消不等于失败，也不等于空。',
    role: 'status',
    ariaLive: 'polite',
    busy: false,
    actionable: true,
    token: 'workbench-state-cancelled',
  }),
  loading: Object.freeze({
    kind: 'loading',
    label: '加载中',
    detail: '正在取数据，请稍候。',
    hint: '按 Esc 可以取消这次加载。',
    role: 'status',
    ariaLive: 'polite',
    busy: true,
    actionable: true,
    token: 'workbench-state-loading',
  }),
});

/** The four kinds, in a stable order. */
export const WORKBENCH_STATE_KINDS = Object.freeze([
  'empty',
  'error',
  'cancelled',
  'loading',
]);

/**
 * The state of a workbench that has NO PROJECT AT ALL.
 *
 * This is NOT a fifth outcome of a catalogue request -- the four states
 * above describe what a REQUEST did, and a request that was never made
 * has no outcome. "There is no project" is a fact about the WORKSPACE,
 * and it needs its own words: it is not "the catalogue is empty" (the
 * catalogue of what? there is nothing to list), and it is not "the load
 * failed" (nothing was loaded).
 *
 * So it lives OUTSIDE `WORKBENCH_STATES`, which stays exactly four
 * entries. The panel composes the two axes: which state the request is
 * in, and whether there is a project to make a request about.
 */
export const NO_PROJECT_STATE = Object.freeze({
  kind: 'no-project',
  label: '尚未选择项目',
  detail: '工作区里还没有 Playwright 项目，所以没有用例可以列出。',
  hint: '点击「添加项目」导入本地 Git 项目，然后即可查看它的测试用例。',
  role: 'status',
  ariaLive: 'polite',
  busy: false,
  actionable: true,
  token: 'workbench-no-project',
});

/**
 * The states a catalogue PANEL can be in.
 *
 * The four request outcomes, plus the workspace-level "no project".
 *
 * @type {readonly string[]}
 */
export const PANEL_STATE_KINDS = Object.freeze([
  ...WORKBENCH_STATE_KINDS,
  'no-project',
]);

/**
 * The state object a PANEL renders.
 *
 * @typedef {object} PanelState
 * @property {WorkbenchStateKind|'no-project'} kind
 * @property {string} label
 * @property {string} detail
 * @property {string} hint
 * @property {string} role
 * @property {string} ariaLive
 * @property {boolean} busy
 * @property {boolean} actionable
 * @property {string} token
 * @property {boolean} [staleData]
 */

/**
 * The outcome of a request, as the caller reports it.
 *
 * @typedef {object} WorkbenchRequest
 * @property {'idle'|'pending'|'settled'|'failed'|'cancelled'} phase
 *           what happened to the request
 * @property {number} [itemCount]        how many items the request produced
 * @property {string} [error]            why it failed
 * @property {boolean} [hasFilter]       a filter is active (so "empty" is explained)
 * @property {boolean} [stale]           the data below is the LAST KNOWN one (a refresh failed)
 */

/**
 * Map a request's outcome onto EXACTLY ONE of the four states.
 *
 * The ORDER of the checks is the specification:
 *
 *   1. a request that is still in flight is LOADING -- whatever else is
 *      true, the reader has to be told that nothing is known YET;
 *   2. a request that was CANCELLED is CANCELLED -- it did not fail, and
 *      it did not succeed either, and it is emphatically not "empty";
 *   3. a request that FAILED is ERROR -- the data does not exist because
 *      the request broke, not because there is none;
 *   4. a request that succeeded with NO items is EMPTY -- the data was
 *      fetched and there is nothing in it;
 *   5. a request that succeeded WITH items is... not a state at all: the
 *      panel shows the data, so there is no state to announce.
 *
 * @param {WorkbenchRequest} request
 * @returns {WorkbenchStateKind|null} the state, or null when the data is
 *   there and no state has to be announced
 */
export function deriveWorkbenchState(request) {
  const r = request || {};
  if (r.phase === 'pending') return 'loading';
  if (r.phase === 'cancelled') return 'cancelled';
  if (r.phase === 'failed') return 'error';
  if (r.phase === 'settled') return (r.itemCount > 0) ? null : 'empty';
  if (r.phase === 'idle') return null;
  // An outcome the model does not know is a fact it does not have. It is
  // reported as a FAILURE: reporting it as "nothing to announce" would
  // present an unknown as a success, and a reader who cannot tell the
  // difference would read "no news" as "all is well".
  return 'error';
}

/**
 * The full state object for a request, or null when none is to be shown.
 *
 * A request that FAILED but still has the LAST KNOWN data is reported as
 * the `error` state WITH `staleData` set: the reader is told the refresh
 * failed, and the data below is marked as old rather than being passed
 * off as current. The state set stays CLOSED -- there is no fifth
 * "stale" state -- because "stale" is not a fact about the request's
 * outcome but an annotation on the data.
 *
 * @param {WorkbenchRequest} request
 * @returns {(WorkbenchState & {staleData?:boolean})|null}
 */
export function workbenchState(request) {
  const kind = deriveWorkbenchState(request);
  if (kind === null) return null;
  const base = WORKBENCH_STATES[kind];
  return request && request.stale ? { ...base, staleData: true } : base;
}

/**
 * The state's label -- the text the reader actually sees.
 *
 * @param {WorkbenchRequest} request
 * @returns {string} the label, or '' when no state is to be announced
 */
export function workbenchStateLabel(request) {
  const s = workbenchState(request);
  return s === null ? '' : s.label;
}

/**
 * The ARIA attributes of the state container.
 *
 * A screen reader must be told WHEN a state appears, so the container is
 * a live region. The politeness follows the urgency: a failure is
 * `assertive` (it interrupts), the other three are `polite` (they wait
 * for a pause in the speech).
 *
 * @param {WorkbenchRequest} request
 * @returns {{role:string,'aria-live':string,'data-state':string,'aria-busy':string}|null}
 */
export function workbenchStateAria(request) {
  const s = workbenchState(request);
  if (s === null) return null;
  return {
    role: s.role,
    'aria-live': s.ariaLive,
    'data-state': s.kind,
    'aria-busy': s.busy ? 'true' : 'false',
  };
}

/**
 * The state of the WHOLE PANEL, given the request's outcome AND whether
 * there is a project at all.
 *
 * The two axes are separate facts:
 *
 *   - the REQUEST outcome (one of the four states above), and
 *   - the WORKSPACE: is there a project whose catalogue could be listed?
 *
 * Without a project there is nothing to load, so the request state is
 * `idle` and the panel must NOT fall through to the "the filter matched
 * nothing" message -- that message talks about a list that does not
 * exist. It gets the workspace-level words instead, with the guidance
 * that actually helps ("import a project").
 *
 * @param {WorkbenchRequest} request
 * @param {{hasProject?:boolean}} [workspace]
 * @returns {(PanelState|null)}
 */
export function panelState(request, workspace = {}) {
  const hasProject = workspace?.hasProject !== false;
  if (!hasProject) return { ...NO_PROJECT_STATE };
  return workbenchState(request);
}

/**
 * The FOUR states must be distinguishable FROM EACH OTHER.
 *
 * This is the acceptance criterion in one predicate, and the unit tests
 * call it directly -- so a future edit that collapses two states into one
 * (say, by making `cancelled` share `empty`'s label) fails the test
 * rather than quietly weakening the criterion.
 *
 * The comparison is over the fields a reader can perceive: the label,
 * the detail, the hint, the role and the busy flag. It is deliberately
 * NOT over the colour: docs/05-UI-UX.md §4 forbids relying on colour
 * alone, so colour differences cannot make two states "different".
 *
 * Two states are distinguishable when they differ in AT LEAST ONE of
 * those fields -- not when they differ in ALL of them. The latter would
 * be the wrong requirement: the three non-error states are all polite
 * `status` live regions, and only the error is an `alert`, so requiring
 * a difference in every field would make the correct implementation look
 * broken. What the criterion forbids is two states that a reader cannot
 * tell apart, and that is exactly "no perceivable difference at all".
 *
 * @param {readonly WorkbenchStateKind[]} [kinds]
 * @returns {boolean} true when every pair of states differs visibly
 */
export function statesAreDistinguishable(kinds = WORKBENCH_STATE_KINDS) {
  for (let i = 0; i < kinds.length; i++) {
    for (let j = i + 1; j < kinds.length; j++) {
      const a = WORKBENCH_STATES[kinds[i]];
      const b = WORKBENCH_STATES[kinds[j]];
      if (!a || !b) return false;
      const differs =
        a.label !== b.label
        || a.detail !== b.detail
        || a.hint !== b.hint
        || a.role !== b.role
        || a.busy !== b.busy;
      if (!differs) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* the keyboard model                                                 */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} KeyCommand
 * @property {string} key           the KeyboardEvent.key
 * @property {boolean} [ctrl]       whether Control must be held
 * @property {string} id            the command's identity
 * @property {string} description   what the command does, in words
 */

/**
 * The commands the workbench answers.
 *
 * Escape cancels what is in flight. Enter submits what is on screen.
 * Ctrl+Enter runs the current case (docs/05-UI-UX.md §4 lists it as the
 * P1 shortcut, and the P0 requirement -- "the core operation is
 * completable with the keyboard" -- needs it to be reachable by keyboard
 * alone, so it is implemented here rather than deferred).
 *
 * THE ESCAPE DESCRIPTION IS THE CONTRACT
 * --------------------------------------
 * The footer prints these descriptions verbatim, so a description that
 * names a capability the workbench does not have is a false claim on
 * the screen -- the round-2 review rejected the delivery for exactly
 * that: the help said 「取消正在进行的加载或运行」 ("cancels the load or
 * run in progress") while pressing Escape during a running test did
 * nothing at all.
 *
 * So the description states what Escape ACTUALLY does, and the two
 * capabilities it covers are both implemented:
 *
 *   - it closes the open dialog;
 *   - it cancels the catalogue load that is in flight;
 *   - and it stops the run that is in flight (the same endpoint as the
 *     「停止运行」 button).
 *
 * The order of those three is the order of nesting: the dialog is the
 * innermost thing, then the load, then the run.
 */
export const KEY_COMMANDS = Object.freeze([
  Object.freeze({
    key: 'Escape',
    id: 'cancel',
    description: '关闭弹窗，或取消正在进行的加载或运行',
  }),
  Object.freeze({
    key: 'Enter',
    id: 'submit',
    description: '提交当前输入（添加项目、保存脚本、确认授权）',
  }),
  Object.freeze({
    key: 'Enter',
    ctrl: true,
    id: 'run-current',
    description: '运行当前选中的用例',
  }),
  Object.freeze({
    key: 'p',
    ctrl: true,
    id: 'focus-search',
    description: '把焦点移到脚本搜索框',
  }),
]);

/**
 * The command a key event asks for.
 *
 * A LETTER shortcut is matched case-insensitively: the browser reports
 * `key` as the character that was produced, so a shortcut that is
 * documented as `Ctrl+P` arrives as `p` on most layouts and as `P` when
 * the user holds Shift as well. A binding that only matched the
 * lowercase form would silently not fire for the reader who pressed
 * Ctrl+Shift+P -- so both spellings are accepted.
 *
 * @param {{key:string,ctrlKey?:boolean,metaKey?:boolean,shiftKey?:boolean,altKey?:boolean}} event
 * @returns {string|null} the command id, or null when the key is not bound
 */
export function keyCommandFor(event) {
  if (!event || typeof event.key !== 'string') return null;
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  for (const command of KEY_COMMANDS) {
    const same = command.key.length === 1
      ? command.key.toLowerCase() === event.key.toLowerCase()
      : command.key === event.key;
    if (!same) continue;
    if (Boolean(command.ctrl) !== ctrl) continue;
    return command.id;
  }
  return null;
}

/**
 * Whether the event is a SUBMIT key press that a form control should
 * handle itself.
 *
 * A plain Enter inside a text field is the browser's own "submit the
 * form" behaviour, and taking it away would break typing. So the
 * workbench's own submit handler only takes Enter when the focus is NOT
 * in a text input -- on a button, for instance, where Enter activates the
 * button natively anyway.
 *
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
export function isTextEntry(target) {
  if (!target || typeof target !== 'object') return false;
  const el = /** @type {HTMLElement} */ (target);
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = /** @type {HTMLInputElement} */ (el).type;
    // Buttons and checkboxes are NOT text entry: Enter on a button
    // activates it, which is what the submit command means.
    return !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(
      (type || 'text').toLowerCase(),
    );
  }
  if (el.isContentEditable === true) return true;
  return false;
}

/**
 * Whether the focused element has a NATIVE action that Enter would
 * trigger on its own.
 *
 * This is the guard that keeps the workbench's submit command from
 * STEALING the Enter key. A `<button>`, an `<a href>` and a `<summary>`
 * all act on Enter by themselves: the browser fires `click`, and the
 * element's own handler runs. If the workbench also intercepts Enter and
 * performs a different write -- say, "add the project" -- then the
 * reader who focused 「取消」 (Cancel) and pressed Enter would ADD a
 * project instead of cancelling. The key must reach the focused
 * control.
 *
 * So the rule is: the submit command only applies when the focused
 * element has NO native Enter action of its own. The command then means
 * "submit the form that contains the focus", which is what the reader
 * expects when the focus is on a plain area or on the body.
 *
 * @param {EventTarget|null} target
 * @returns {boolean} true when the focus has its own Enter action
 */
export function hasNativeEnterAction(target) {
  if (!target || typeof target !== 'object') return false;
  const el = /** @type {HTMLElement} */ (target);
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  if (tag === 'button') return true;
  if (tag === 'a') return el.hasAttribute('href');
  if (tag === 'summary') return true;
  if (tag === 'input') {
    const type = /** @type {HTMLInputElement} */ (el).type;
    // A submit button acts on Enter; a text field submits the form it is
    // in (that is `isTextEntry`, handled by the caller); the rest do
    // not.
    return ['button', 'submit', 'reset'].includes((type || 'text').toLowerCase());
  }
  if (el.isContentEditable === true) return true;
  return false;
}

/**
 * Whether the event is an INPUT COMPOSITION (an IME candidate window).
 *
 * While a reader is choosing a candidate word, Escape belongs to the
 * IME: it dismisses the candidate list. If the workbench also treats
 * that Escape as "cancel the load", the reader's act of dismissing a
 * candidate window would cancel the workbench's work as well -- and in
 * the add-project dialog it would close the dialog.
 *
 * @param {{isComposing?:boolean,keyCode?:number}} event
 * @returns {boolean}
 */
export function isComposing(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.isComposing === true) return true;
  // 229 is the legacy "IME is processing this key" code, still reported
  // by Chromium for the composition keystrokes.
  return event.keyCode === 229;
}

/**
 * Whether the event should be handled by the workbench AT ALL.
 *
 * Two things disqualify it:
 *
 *   1. the reader is choosing an IME candidate -- the key belongs to
 *      the input method (see `isComposing`);
 *   2. the reader is typing into a text field and pressed Enter -- the
 *      browser's own form submission is the right behaviour (see
 *      `isTextEntry`).
 *
 * @param {{isComposing?:boolean,keyCode?:number}} event
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
export function shouldHandleKey(event, target) {
  if (isComposing(event)) return false;
  if (isTextEntry(target)) return false;
  return true;
}

/**
 * The FOCUS ORDER of the workbench.
 *
 * The order is the READING order, and it is a property of the model
 * rather than of the markup: the DOM order and this order must agree.
 * The ST probe measures the real Tab order in a real browser
 * (tools/ats111-probes/st-ats111.mjs) and compares it with this list
 * -- and the comparison is on the ORDER, so a DOM whose regions were
 * moved fails the check.
 *
 * The list is grouped by the region it belongs to, so a reader can be
 * told "the rail comes first, then the header, then the sidebar, then
 * the content" -- which is also the order the eye takes.
 *
 * The `sidebar` region is the resource list itself; the `panel` region
 * is the catalogue list inside it. The sidebar comes first because it
 * is the outer element.
 *
 * @type {readonly string[]}
 */
export const FOCUS_ORDER = Object.freeze([
  'rail',
  'refresh',
  'project-select',
  'add-project',
  'search',
  'sidebar',
  'panel',
  'content',
]);

/**
 * What the Escape key should act on.
 *
 * The three things Escape can cancel are NESTED, and the innermost one
 * wins:
 *
 *   1. the DIALOG -- a modal that is open is the innermost thing the
 *      reader can be doing, so Escape closes it;
 *   2. the LOAD -- a catalogue request that is still in flight;
 *   3. the RUN -- a test run that is still in flight.
 *
 * The order is not arbitrary: pressing Escape while the dialog is open
 * must NOT also cancel the load behind it, and pressing Escape while a
 * load is in flight must NOT stop a run that the reader did not ask
 * about. So the function returns the SINGLE target, or null when there
 * is nothing to cancel.
 *
 * The round-2 review found that the footer claimed Escape "cancels the
 * load or the run" while it did neither for a run. Making the decision
 * a MODEL function means the unit tests can assert the whole table
 * without a browser, and the view only has to carry it out.
 *
 * @typedef {'dialog'|'load'|'run'|null} EscapeTarget
 *
 * @param {{dialogOpen?:boolean,loadPending?:boolean,runActive?:boolean}} state
 * @returns {EscapeTarget}
 */
export function escapeTarget(state) {
  const s = state || {};
  if (s.dialogOpen === true) return 'dialog';
  if (s.loadPending === true) return 'load';
  if (s.runActive === true) return 'run';
  return null;
}

/**
 * Whether the given order is the EXPECTED one.
 *
 * A unit-testable predicate so that a change to the focus order is a
 * deliberate, reviewed change rather than an accident of the markup.
 *
 * @param {readonly string[]} order
 * @returns {boolean}
 */
export function focusOrderIsCorrect(order) {
  if (!Array.isArray(order)) return false;
  if (order.length !== FOCUS_ORDER.length) return false;
  for (let i = 0; i < FOCUS_ORDER.length; i++) {
    if (order[i] !== FOCUS_ORDER[i]) return false;
  }
  return true;
}

/**
 * Whether the observed order is CONSISTENT with the declared one.
 *
 * The DOM may have more stops inside a region -- the six rail buttons,
 * the list items, the tag chips -- so the observed sequence is a
 * sequence of REGIONS with repetitions. The check is therefore:
 *
 *   1. every observed region is one the model declares;
 *   2. the DISTINCT regions, in the order they were first reached, must
 *      sit at STRICTLY INCREASING indices in the declared order -- so
 *      the walk moves FORWARD through the reading order.
 *
 * The comparison uses the ORDER. It is not "the declared order
 * restricted to the observed regions": that formulation compares the
 * observed sequence with itself, so a fully REVERSED sequence would
 * pass and the check could not fail. A DOM whose regions were
 * reordered produces a different sequence and fails -- which is the
 * whole point: a check that compares a list with itself cannot fail.
 *
 * @param {readonly string[]} observed the regions, in the order the
 *   keyboard reached them (with repetitions)
 * @returns {boolean}
 */
export function observedFocusOrderIsConsistent(observed) {
  if (!Array.isArray(observed)) return false;
  // The observed sequence is the sequence of DISTINCT regions, in the
  // order the keyboard first reached them. Each of them must sit at a
  // STRICTLY INCREASING index in the declared order.
  //
  // That is the comparison that uses the ORDER. It is not "the declared
  // order restricted to the observed regions": that formulation
  // compares the observed sequence with itself, so a fully REVERSED
  // sequence would pass and the check could not fail.
  let previousIndex = -1;
  const seen = new Set();
  for (const region of observed) {
    const index = FOCUS_ORDER.indexOf(region);
    // A region the model does not declare is a mismatch.
    if (index === -1) return false;
    // The same region reached twice in a row is not a new stop.
    if (seen.has(region)) continue;
    seen.add(region);
    // The order must move FORWARD.
    if (index <= previousIndex) return false;
    previousIndex = index;
  }
  return seen.size > 0;
}

/**
 * The regions of the workbench, and the ARIA landmark role each carries.
 *
 * The landmarks are what let a screen-reader user skip to the region
 * they want -- the equivalent of "Tab order is sensible", for a reader
 * who navigates by landmark rather than by Tab.
 *
 * A role that the markup does NOT carry is a claim the reader cannot
 * check: a screen reader announces the role, so a declared role that the
 * DOM does not have is a false description of the page. So the table
 * below lists only roles that the markup REALLY has, and the unit test
 * asserts that each declared role is present on the declared element.
 *
 * The elements that carry a region are:
 *
 *   rail            the <aside role="navigation">
 *   refresh         the top bar's refresh <button> (a plain button --
 *                   it is not a landmark, and calling it one would be a
 *                   false description)
 *   project-select  the <select> in the project bar
 *   add-project     the 「添加项目」 <button>
 *   search          the <div role="search"> around the search input
 *   panel           the catalogue's <div> (a plain region, not a
 *                   landmark)
 *   content         the <main role="main">
 *
 * @type {Readonly<Record<string,string>>}
 */
export const LANDMARK_ROLES = Object.freeze({
  rail: 'navigation',
  'project-select': 'none',
  'add-project': 'none',
  refresh: 'none',
  search: 'search',
  sidebar: 'none',
  panel: 'none',
  content: 'main',
});

/**
 * The regions that ARE landmarks.
 *
 * A landmark is a region a screen reader can jump to by role. The
 * others are ordinary controls that happen to carry a `data-region` so
 * that the focus order can be measured.
 *
 * @type {readonly string[]}
 */
export const LANDMARK_REGIONS = Object.freeze(
  Object.keys(LANDMARK_ROLES).filter((r) => LANDMARK_ROLES[r] !== 'none'),
);

/**
 * The DOM order of the regions, by their position in the markup.
 *
 * The topbar -- and with it the refresh button -- is rendered ABOVE the
 * project bar, so the keyboard reaches `refresh` before `project-select`.
 * The ST probe measured this in a real browser (tools/ats111-probes/
 * st-ats111.mjs), and the model follows the measurement: a model that
 * disagreed with the DOM would be a claim, not a specification.
 */

/**
 * The keyboard help text the workbench shows.
 *
 * It is a MODEL, not a string built by hand in the view, so that the
 * unit test can assert that every bound command is described -- a
 * command that exists but is not documented is a defect (the reader
 * cannot discover it).
 *
 * @returns {string[]}
 */
export function keyboardHelpLines() {
  return KEY_COMMANDS.map((c) => {
    // A letter is shown in UPPERCASE, the way it is written on a key
    // cap: the binding matches either case, so the help must not make
    // the reader guess which spelling the browser will report.
    const key = c.key.length === 1 ? c.key.toUpperCase() : c.key;
    const combo = c.ctrl ? `Ctrl+${key}` : key;
    return `${combo} — ${c.description}`;
  });
}

/**
 * Every bound command is described in the help text.
 *
 * @returns {boolean}
 */
export function keyboardHelpIsComplete() {
  const lines = keyboardHelpLines();
  return KEY_COMMANDS.every((c) => {
    // The help spells a letter key in UPPERCASE, so the check has to
    // look for the SAME spelling -- otherwise the check would be
    // asserting a format the help does not use.
    const key = c.key.length === 1 ? c.key.toUpperCase() : c.key;
    const combo = c.ctrl ? `Ctrl+${key}` : key;
    return lines.some((l) => l.includes(combo) && l.includes(c.description));
  });
}
