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
 */
export const KEY_COMMANDS = Object.freeze([
  Object.freeze({
    key: 'Escape',
    id: 'cancel',
    description: '取消正在进行的加载或运行',
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
 * The FOCUS ORDER of the workbench.
 *
 * The order is the READING order, and it is a property of the model
 * rather than of the markup: the DOM order and this order must agree,
 * and the unit test asserts that they do by reading the rendered page
 * (see the ST probe) and by checking this list against the rail/panel
 * structure.
 *
 * The list is grouped by the region it belongs to, so a reader can be
 * told "the rail comes first, then the header, then the sidebar, then
 * the content" -- which is also the order the eye takes.
 *
 * @type {readonly string[]}
 */
export const FOCUS_ORDER = Object.freeze([
  'rail',
  'refresh',
  'project-select',
  'add-project',
  'search',
  'panel',
  'content',
]);

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
 * The regions of the workbench, and the ARIA landmark role each carries.
 *
 * The landmarks are what let a screen-reader user skip to the region
 * they want -- the equivalent of "Tab order is sensible", for a reader
 * who navigates by landmark rather than by Tab.
 *
 * @type {Readonly<Record<string,string>>}
 */
export const LANDMARK_ROLES = Object.freeze({
  rail: 'navigation',
  'project-select': 'region',
  'add-project': 'region',
  refresh: 'region',
  search: 'search',
  panel: 'region',
  content: 'main',
});

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
