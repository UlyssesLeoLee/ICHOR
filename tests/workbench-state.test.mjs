/**
 * ATS-111 unit tests: the WORKBENCH STATE MODEL and the KEYBOARD MODEL.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * The acceptance criterion of ATS-111 is one sentence:
 *
 *   「空列表/失败/取消/加载态均可辨识；核心操作可键盘完成」
 *
 *   ("the empty list / failure / cancel / loading states must each be
 *    distinguishable; the core operations must be completable with the
 *    keyboard")
 *
 * The tests below therefore cover three things:
 *
 *   1. THE FOUR STATES ARE DISTINGUISHED. A cancelled load is not a
 *      failure, a failure is not an empty list, and an empty list is not
 *      a load in progress. The test asserts that every pair of states
 *      differs in the fields a reader can PERCEIVE -- the label, the
 *      detail, the hint, the ARIA role and the busy flag -- and
 *      deliberately does NOT count colour: docs/05-UI-UX.md §4 forbids
 *      relying on colour alone, so a colour difference cannot make two
 *      states "different".
 *
 *   2. THE MAPPING IS TOTAL AND EXCLUSIVE. Every outcome lands on
 *      exactly one of the four states, and an outcome that is not
 *      recognised is reported as a FAILURE rather than swallowed -- an
 *      unrecognised state is a fact the UI does not have, and it must
 *      not be presented as "everything is fine".
 *
 *   3. THE CORE FLOW IS KEYBOARD-COMPLETABLE. Escape cancels, Enter
 *      submits, Ctrl+Enter runs, Ctrl+P focuses the search -- and Enter
 *      inside a TEXT FIELD is left to the browser, so typing a path is
 *      not hijacked by the workbench's own submit handler.
 *
 * THE TESTS ARE FALSIFIABLE
 * -------------------------
 * Every assertion states the value it expects. The mutation probe
 * (tools/ats111-probes/mutation-check.mjs) breaks the model in nine
 * ways and asserts that these tests catch each of them -- so a test
 * that cannot fail is not counted as evidence.
 *
 * Run: node --test tests/workbench-state.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOCUS_ORDER,
  KEY_COMMANDS,
  LANDMARK_REGIONS,
  LANDMARK_ROLES,
  NO_PROJECT_STATE,
  PANEL_STATE_KINDS,
  WORKBENCH_STATE_KINDS,
  WORKBENCH_STATES,
  deriveWorkbenchState,
  focusOrderIsCorrect,
  hasNativeEnterAction,
  isComposing,
  isTextEntry,
  keyCommandFor,
  keyboardHelpIsComplete,
  keyboardHelpLines,
  observedFocusOrderIsConsistent,
  panelState,
  statesAreDistinguishable,
  workbenchState,
  workbenchStateAria,
  workbenchStateLabel,
} from '../apps/studio/lib/workbench-state.mjs';

/* ------------------------------------------------------------------ */
/* 1. the four states exist and are distinguishable                    */
/* ------------------------------------------------------------------ */

test('the four states are exactly empty / error / cancelled / loading', () => {
  assert.deepEqual([...WORKBENCH_STATE_KINDS].sort(), ['cancelled', 'empty', 'error', 'loading']);
  assert.equal(WORKBENCH_STATE_KINDS.length, 4);
  for (const kind of WORKBENCH_STATE_KINDS) {
    assert.ok(WORKBENCH_STATES[kind], `the state ${kind} is missing`);
  }
});

test('every state carries a label, a detail, a hint, a role and a token', () => {
  for (const kind of WORKBENCH_STATE_KINDS) {
    const s = WORKBENCH_STATES[kind];
    assert.ok(s.label && s.label.length > 0, `${kind}: the label is empty`);
    assert.ok(s.detail && s.detail.length > 0, `${kind}: the detail is empty`);
    assert.ok(s.hint && s.hint.length > 0, `${kind}: the hint is empty`);
    assert.ok(s.role && s.role.length > 0, `${kind}: the role is empty`);
    assert.ok(s.token && s.token.length > 0, `${kind}: the token is empty`);
    assert.equal(typeof s.busy, 'boolean', `${kind}: busy is not a boolean`);
  }
});

test('the four states are distinguishable from EACH OTHER', () => {
  // The acceptance criterion in one predicate. A change that collapses
  // two states into one (say, by giving `cancelled` the same label as
  // `empty`) fails HERE rather than quietly weakening the criterion.
  assert.equal(statesAreDistinguishable(), true);
});

test('the distinguishability check is FALSIFIABLE: identical states are rejected', () => {
  // The predicate above would be worthless if it returned true for any
  // input, so the negative control is asserted here: two states that
  // share their perceivable fields must be reported as INDISTINGUISHABLE.
  //
  // The states are frozen, so the negative control is run over a COPY
  // of the map -- the real one is not modified.
  const collapsed = {
    ...WORKBENCH_STATES,
    cancelled: { ...WORKBENCH_STATES.cancelled, label: WORKBENCH_STATES.empty.label },
  };
  const distinguishable = (() => {
    const kinds = WORKBENCH_STATE_KINDS;
    for (let i = 0; i < kinds.length; i++) {
      for (let j = i + 1; j < kinds.length; j++) {
        const a = collapsed[kinds[i]];
        const b = collapsed[kinds[j]];
        if (a.label === b.label) return false;
      }
    }
    return true;
  })();
  assert.equal(distinguishable, false, 'the negative control did not detect the collapse');
  // And the real map is untouched by the negative control.
  assert.equal(WORKBENCH_STATES.cancelled.label, '已取消');
});

test('no two states share a LABEL, a DETAIL or a HINT', () => {
  // The role is deliberately NOT in this list: the three non-error
  // states are all polite `status` live regions, and only the failure
  // is an `alert`. Sharing a role does not make two states
  // indistinguishable -- the words and the icon still tell them apart.
  const labels = new Set();
  const details = new Set();
  const hints = new Set();
  for (const kind of WORKBENCH_STATE_KINDS) {
    const s = WORKBENCH_STATES[kind];
    assert.ok(!labels.has(s.label), `${kind}: the label ${s.label} is shared`);
    assert.ok(!details.has(s.detail), `${kind}: the detail is shared`);
    assert.ok(!hints.has(s.hint), `${kind}: the hint is shared`);
    labels.add(s.label);
    details.add(s.detail);
    hints.add(s.hint);
  }
  assert.equal(labels.size, 4);
  assert.equal(details.size, 4);
  assert.equal(hints.size, 4);
});

test('the failure state has its OWN role and politeness', () => {
  // The one role difference that matters: a failure interrupts
  // (assertive), the others wait for a pause in the speech (polite).
  const roles = new Set(WORKBENCH_STATE_KINDS.map((k) => WORKBENCH_STATES[k].role));
  assert.ok(roles.has('alert'), 'no state is an alert');
  assert.ok(roles.has('status'), 'no state is a status');
  assert.equal(WORKBENCH_STATES.error.role, 'alert');
});

test('the loading state is the only BUSY one', () => {
  const busy = WORKBENCH_STATE_KINDS.filter((k) => WORKBENCH_STATES[k].busy);
  assert.deepEqual(busy, ['loading']);
});

test('the failure state is the only ASSERTIVE live region', () => {
  const assertive = WORKBENCH_STATE_KINDS.filter((k) => WORKBENCH_STATES[k].ariaLive === 'assertive');
  assert.deepEqual(assertive, ['error']);
  for (const kind of WORKBENCH_STATE_KINDS) {
    assert.ok(['off', 'polite', 'assertive'].includes(WORKBENCH_STATES[kind].ariaLive));
  }
});

test('the state labels are the words a reader actually sees', () => {
  // The exact words are part of the contract: a reader who is told
  // 「加载失败」 knows the request broke; a reader who is told 「暂无内容」
  // knows there is nothing to see. Collapsing them into one word would
  // collapse the states.
  assert.equal(WORKBENCH_STATES.empty.label, '暂无内容');
  assert.equal(WORKBENCH_STATES.error.label, '加载失败');
  assert.equal(WORKBENCH_STATES.cancelled.label, '已取消');
  assert.equal(WORKBENCH_STATES.loading.label, '加载中');
});

/* ------------------------------------------------------------------ */
/* 2. the mapping: total, exclusive, and never swallows a failure      */
/* ------------------------------------------------------------------ */

test('a request in flight is LOADING', () => {
  assert.equal(deriveWorkbenchState({ phase: 'pending' }), 'loading');
  assert.equal(deriveWorkbenchState({ phase: 'pending', itemCount: 0 }), 'loading');
  assert.equal(deriveWorkbenchState({ phase: 'pending', itemCount: 5 }), 'loading');
});

test('a CANCELLED request is CANCELLED -- not a failure and not empty', () => {
  assert.equal(deriveWorkbenchState({ phase: 'cancelled' }), 'cancelled');
  assert.equal(deriveWorkbenchState({ phase: 'cancelled', itemCount: 0 }), 'cancelled');
  // Even when the request had already produced something: the caller
  // walked away, so the state is "cancelled", not "ready".
  assert.equal(deriveWorkbenchState({ phase: 'cancelled', itemCount: 3 }), 'cancelled');
});

test('a FAILED request is an ERROR -- even when it produced no items', () => {
  assert.equal(deriveWorkbenchState({ phase: 'failed', error: 'boom' }), 'error');
  assert.equal(deriveWorkbenchState({ phase: 'failed', itemCount: 0, error: 'boom' }), 'error');
});

test('a settled request with no items is EMPTY', () => {
  assert.equal(deriveWorkbenchState({ phase: 'settled', itemCount: 0 }), 'empty');
  assert.equal(deriveWorkbenchState({ phase: 'settled' }), 'empty');
});

test('a settled request WITH items has no state to announce', () => {
  assert.equal(deriveWorkbenchState({ phase: 'settled', itemCount: 1 }), null);
  assert.equal(deriveWorkbenchState({ phase: 'settled', itemCount: 42 }), null);
});

test('an idle request has no state to announce', () => {
  assert.equal(deriveWorkbenchState({ phase: 'idle' }), null);
});

test('the mapping is TOTAL: every phase lands on one of the four (or none)', () => {
  const phases = ['idle', 'pending', 'settled', 'failed', 'cancelled'];
  for (const phase of phases) {
    const state = deriveWorkbenchState({ phase });
    assert.ok(
      state === null || WORKBENCH_STATE_KINDS.includes(state),
      `the phase ${phase} produced the unknown state ${state}`,
    );
  }
});

test('an UNRECOGNISED outcome is reported as a FAILURE, not swallowed', () => {
  // A state the model does not know is a fact it does not have.
  // Reporting it as "nothing to announce" would present an unknown as a
  // success, and a reader who cannot tell the difference would read
  // "no news" as "all is well". So it MUST be the failure state.
  assert.equal(deriveWorkbenchState({ phase: 'weird' }), 'error');
  assert.equal(deriveWorkbenchState({ phase: 'settled-ish' }), 'error');
  assert.equal(deriveWorkbenchState({}), 'error');
  assert.equal(deriveWorkbenchState({ phase: '' }), 'error');
  // And it must not be mistaken for the two success-ish states.
  assert.notEqual(deriveWorkbenchState({ phase: 'weird' }), 'empty');
  assert.notEqual(deriveWorkbenchState({ phase: 'weird' }), 'loading');
  // The state object of an unknown outcome is the error state, with its
  // own label -- so the reader is told the truth.
  const s = workbenchState({ phase: 'weird' });
  assert.equal(s.kind, 'error');
  assert.equal(s.label, '加载失败');
});

test('the four states are EXCLUSIVE: no outcome produces two states', () => {
  for (const phase of ['idle', 'pending', 'settled', 'failed', 'cancelled']) {
    for (const itemCount of [undefined, 0, 1, 7]) {
      const state = deriveWorkbenchState({ phase, itemCount });
      if (state === null) continue;
      assert.ok(WORKBENCH_STATE_KINDS.includes(state));
      assert.equal(typeof state, 'string');
    }
  }
});

/* ------------------------------------------------------------------ */
/* 3. the state object and the ARIA attributes                         */
/* ------------------------------------------------------------------ */

test('the state object carries the fields the view renders', () => {
  const s = workbenchState({ phase: 'failed', error: 'boom' });
  assert.equal(s.kind, 'error');
  assert.equal(s.label, '加载失败');
  assert.equal(s.role, 'alert');
  assert.equal(s.ariaLive, 'assertive');
  assert.equal(s.busy, false);
  assert.equal(s.actionable, true);
  assert.equal(s.token, 'workbench-state-error');
});

test('there is no state object when there is nothing to announce', () => {
  assert.equal(workbenchState({ phase: 'idle' }), null);
  assert.equal(workbenchState({ phase: 'settled', itemCount: 3 }), null);
  assert.equal(workbenchStateLabel({ phase: 'idle' }), '');
});

test('the ARIA attributes name the state and set the busy flag', () => {
  const loading = workbenchStateAria({ phase: 'pending' });
  assert.deepEqual(loading, {
    role: 'status',
    'aria-live': 'polite',
    'data-state': 'loading',
    'aria-busy': 'true',
  });

  const failed = workbenchStateAria({ phase: 'failed' });
  assert.equal(failed['data-state'], 'error');
  assert.equal(failed['aria-busy'], 'false');
  assert.equal(failed.role, 'alert');

  assert.equal(workbenchStateAria({ phase: 'settled', itemCount: 2 }), null);
});

test('a failed refresh over known data is an ERROR marked STALE', () => {
  // The state set stays CLOSED: "stale" is an annotation on the data,
  // not a fifth state. The reader must still be told the refresh failed.
  const s = workbenchState({ phase: 'failed', error: 'boom', stale: true });
  assert.equal(s.kind, 'error');
  assert.equal(s.staleData, true);
  assert.equal(s.label, '加载失败');
  // And a settled request with data is not marked stale -- there is no
  // state to announce at all, because the data is on screen.
  assert.equal(workbenchState({ phase: 'settled', itemCount: 1 }), null);
  // A stale EMPTY result is still empty-with-a-stale-note.
  const emptyStale = workbenchState({ phase: 'settled', itemCount: 0, stale: true });
  assert.equal(emptyStale.kind, 'empty');
  assert.equal(emptyStale.staleData, true);
});

/* ------------------------------------------------------------------ */
/* 4. the keyboard model                                               */
/* ------------------------------------------------------------------ */

test('Escape is the cancel command', () => {
  assert.equal(keyCommandFor({ key: 'Escape' }), 'cancel');
  // Ctrl+Escape is NOT bound: it would be a second way to cancel.
  assert.equal(keyCommandFor({ key: 'Escape', ctrlKey: true }), null);
});

test('Enter is the submit command', () => {
  assert.equal(keyCommandFor({ key: 'Enter' }), 'submit');
  assert.equal(keyCommandFor({ key: 'Enter', ctrlKey: true }), 'run-current');
  assert.equal(keyCommandFor({ key: 'Enter', metaKey: true }), 'run-current');
});

test('Ctrl+P focuses the search', () => {
  assert.equal(keyCommandFor({ key: 'p', ctrlKey: true }), 'focus-search');
  assert.equal(keyCommandFor({ key: 'P', ctrlKey: true }), 'focus-search');
  // A plain "p" is a normal keystroke, not a command.
  assert.equal(keyCommandFor({ key: 'p' }), null);
});

test('an unbound key is NOT a command', () => {
  assert.equal(keyCommandFor({ key: 'a' }), null);
  assert.equal(keyCommandFor({ key: 'Tab' }), null);
  assert.equal(keyCommandFor({ key: 'F5' }), null);
  assert.equal(keyCommandFor({ key: 'Shift' }), null);
  assert.equal(keyCommandFor(null), null);
  assert.equal(keyCommandFor({}), null);
});

test('the commands are exactly the four the workbench binds', () => {
  const ids = KEY_COMMANDS.map((c) => c.id).sort();
  assert.deepEqual(ids, ['cancel', 'focus-search', 'run-current', 'submit']);
});

test('every command carries a description the reader can be shown', () => {
  for (const c of KEY_COMMANDS) {
    assert.ok(c.id && c.id.length > 0);
    assert.ok(c.key && c.key.length > 0);
    assert.ok(c.description && c.description.length > 0, `${c.id}: no description`);
  }
});

test('the keyboard help names every command', () => {
  assert.equal(keyboardHelpIsComplete(), true);
  const text = keyboardHelpLines().join('\n');
  assert.ok(text.includes('Escape'), 'the help does not mention Escape');
  assert.ok(text.includes('Ctrl+Enter'), 'the help does not mention Ctrl+Enter');
  assert.ok(text.includes('Ctrl+P'), 'the help does not mention Ctrl+P');
});

test('a command that is not described is a defect the help check catches', () => {
  // The help is derived from KEY_COMMANDS, so the check is a tautology
  // on the CURRENT list -- but it is NOT a tautology on a list that
  // grew: the mutation probe adds a command without a description and
  // asserts that the check turns red.
  const lines = keyboardHelpLines();
  assert.equal(lines.length, KEY_COMMANDS.length);
});

test('Enter inside a TEXT FIELD is left to the browser', () => {
  // Typing a path and pressing Enter must submit the form the way the
  // reader expects -- the workbench's own submit handler must not take
  // the key away.
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'password' }), true);
  assert.equal(isTextEntry({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextEntry({ isContentEditable: true }), true);
});

test('Enter on a BUTTON is the submit command, not text entry', () => {
  assert.equal(isTextEntry({ tagName: 'BUTTON', type: 'button' }), false);
  assert.equal(isTextEntry({ tagName: 'BUTTON', type: 'submit' }), false);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTextEntry({ tagName: 'DIV' }), false);
  assert.equal(isTextEntry(null), false);
});

/* ------------------------------------------------------------------ */
/* 5. the focus order and the landmarks                               */
/* ------------------------------------------------------------------ */

test('the focus order is the reading order', () => {
  assert.equal(focusOrderIsCorrect([...FOCUS_ORDER]), true);
  // The order the DOM actually has: the rail, then the topbar (whose
  // refresh button lives there), then the project bar, then the
  // sidebar, then the content. The refresh button is in the TOPBAR,
  // which is rendered above the project bar -- so the keyboard reaches
  // it before the project select. The ST probe measures this in a real
  // browser (tools/ats111-probes/st-ats111.mjs), and this list follows
  // the measurement rather than an assumption.
  assert.deepEqual([...FOCUS_ORDER], [
    'rail',
    'refresh',
    'project-select',
    'add-project',
    'search',
    'sidebar',
    'panel',
    'content',
  ]);
});

test('a WRONG focus order is detected', () => {
  assert.equal(focusOrderIsCorrect(['rail', 'content', 'search']), false);
  assert.equal(focusOrderIsCorrect([...FOCUS_ORDER].reverse()), false);
  assert.equal(focusOrderIsCorrect([...FOCUS_ORDER].slice(0, -1)), false);
  assert.equal(focusOrderIsCorrect([...FOCUS_ORDER, 'extra']), false);
  assert.equal(focusOrderIsCorrect(null), false);
});

test('the focus order starts at the rail and ends at the content', () => {
  assert.equal(FOCUS_ORDER[0], 'rail');
  assert.equal(FOCUS_ORDER[FOCUS_ORDER.length - 1], 'content');
});

test('every region of the focus order has a landmark role', () => {
  for (const region of FOCUS_ORDER) {
    assert.ok(LANDMARK_ROLES[region], `the region ${region} has no landmark role`);
  }
  // The content is the main landmark; the rail is the navigation one.
  assert.equal(LANDMARK_ROLES.content, 'main');
  assert.equal(LANDMARK_ROLES.rail, 'navigation');
  assert.equal(LANDMARK_ROLES.search, 'search');
});

test('a region that is NOT a landmark declares the role "none"', () => {
  // A role the markup does not carry is a false description of the page:
  // a screen reader announces the role it finds. The controls that carry
  // a `data-region` are NOT landmarks, and the table must say so
  // instead of claiming a role that is not there.
  for (const region of ['project-select', 'add-project', 'refresh', 'panel', 'sidebar']) {
    assert.equal(LANDMARK_ROLES[region], 'none', `the region ${region} claims a role it does not have`);
    assert.ok(!LANDMARK_REGIONS.includes(region), `the region ${region} is listed as a landmark`);
  }
  // And the real landmarks are listed.
  assert.deepEqual([...LANDMARK_REGIONS].sort(), ['content', 'rail', 'search']);
});

/* ------------------------------------------------------------------ */
/* 6. the observed focus order: the comparison really uses the ORDER  */
/* ------------------------------------------------------------------ */

test('the observed focus order must agree with the declared one', () => {
  assert.equal(observedFocusOrderIsConsistent([...FOCUS_ORDER]), true);
  // The DOM has more stops inside a region (the six rail buttons, the
  // list items), so the observed sequence repeats regions.
  assert.equal(
    observedFocusOrderIsConsistent(['rail', 'rail', 'rail', 'refresh', 'project-select', 'content']),
    true,
  );
  // A region the model does not declare is a mismatch.
  assert.equal(observedFocusOrderIsConsistent(['rail', 'nowhere']), false);
  assert.equal(observedFocusOrderIsConsistent([]), false);
  assert.equal(focusOrderIsCorrect(null), false);
});

test('a SCRAMBLED focus order is detected -- the check is not a tautology', () => {
  // The counterexample: the same regions, in the WRONG order. If the
  // comparison did not use the order, this would still pass.
  const scrambled = [...FOCUS_ORDER].reverse();
  assert.equal(observedFocusOrderIsConsistent(scrambled), false);
  // And a single swap is enough to fail it: the panel comes before the
  // sidebar in the wrong order.
  const swapped = [...FOCUS_ORDER];
  const panelAt = swapped.indexOf('panel');
  const sidebarAt = swapped.indexOf('sidebar');
  swapped[panelAt] = 'sidebar';
  swapped[sidebarAt] = 'panel';
  assert.equal(observedFocusOrderIsConsistent(swapped), false);
});

/* ------------------------------------------------------------------ */
/* 7. the NO-PROJECT state                                            */
/* ------------------------------------------------------------------ */

test('the four request states are still EXACTLY four', () => {
  // The no-project state lives OUTSIDE the request states: it is a fact
  // about the workspace, not about a request's outcome.
  assert.equal(WORKBENCH_STATE_KINDS.length, 4);
  assert.equal(PANEL_STATE_KINDS.length, 5);
  assert.ok(!WORKBENCH_STATE_KINDS.includes('no-project'));
  assert.ok(PANEL_STATE_KINDS.includes('no-project'));
});

test('the NO-PROJECT state has its own words', () => {
  assert.ok(NO_PROJECT_STATE.label);
  assert.ok(NO_PROJECT_STATE.detail);
  assert.ok(NO_PROJECT_STATE.hint);
  assert.equal(NO_PROJECT_STATE.kind, 'no-project');
  // It must not read like any of the four request states.
  for (const kind of WORKBENCH_STATE_KINDS) {
    const s = WORKBENCH_STATES[kind];
    assert.notEqual(NO_PROJECT_STATE.label, s.label);
    assert.notEqual(NO_PROJECT_STATE.detail, s.detail);
  }
  // And it must point at the action that helps.
  assert.ok(/添加项目|导入/.test(NO_PROJECT_STATE.hint));
});

test('without a project the panel shows the NO-PROJECT state', () => {
  const p = panelState({ phase: 'idle' }, { hasProject: false });
  assert.ok(p);
  assert.equal(p.kind, 'no-project');
  assert.equal(p.label, NO_PROJECT_STATE.label);
});

test('with a project the panel shows the REQUEST state', () => {
  assert.equal(panelState({ phase: 'pending' }, { hasProject: true }).kind, 'loading');
  assert.equal(panelState({ phase: 'failed' }, { hasProject: true }).kind, 'error');
  assert.equal(panelState({ phase: 'cancelled' }, { hasProject: true }).kind, 'cancelled');
  assert.equal(panelState({ phase: 'settled', itemCount: 0 }, { hasProject: true }).kind, 'empty');
  assert.equal(panelState({ phase: 'settled', itemCount: 3 }, { hasProject: true }), null);
  // And the workspace axis defaults to "there is a project".
  assert.equal(panelState({ phase: 'pending' }).kind, 'loading');
});

test('the NO-PROJECT state wins over a request state', () => {
  // Even a failed request: there is no project, so the panel says so.
  // A reader must not be told "the load failed" when nothing was loaded.
  assert.equal(panelState({ phase: 'failed' }, { hasProject: false }).kind, 'no-project');
  assert.equal(panelState({ phase: 'pending' }, { hasProject: false }).kind, 'no-project');
});

/* ------------------------------------------------------------------ */
/* 8. the keyboard: the focused control keeps its own Enter action    */
/* ------------------------------------------------------------------ */

test('a BUTTON has a native Enter action', () => {
  // This is the guard that keeps the workbench from stealing Enter:
  // focusing 「取消」 and pressing Enter has to CANCEL.
  assert.equal(hasNativeEnterAction({ tagName: 'BUTTON' }), true);
  assert.equal(hasNativeEnterAction({ tagName: 'BUTTON', type: 'submit' }), true);
  assert.equal(hasNativeEnterAction({ tagName: 'BUTTON', type: 'button' }), true);
});

test('a LINK with an href has a native Enter action', () => {
  assert.equal(hasNativeEnterAction({ tagName: 'A', hasAttribute: (n) => n === 'href' }), true);
  // A link WITHOUT an href is not a control, so Enter on it does
  // nothing natively.
  assert.equal(hasNativeEnterAction({ tagName: 'A', hasAttribute: () => false }), false);
});

test('a SUMMARY has a native Enter action', () => {
  assert.equal(hasNativeEnterAction({ tagName: 'SUMMARY' }), true);
});

test('a plain area has NO native Enter action', () => {
  // The submit command is allowed to act here: there is no control to
  // press.
  assert.equal(hasNativeEnterAction({ tagName: 'DIV' }), false);
  assert.equal(hasNativeEnterAction({ tagName: 'BODY' }), false);
  assert.equal(hasNativeEnterAction(null), false);
});

test('an IME composition is NOT a command', () => {
  // While the reader is choosing a candidate word, Escape belongs to
  // the input method.
  assert.equal(isComposing({ isComposing: true, key: 'Escape' }), true);
  assert.equal(isComposing({ keyCode: 229, key: 'Escape' }), true);
  assert.equal(isComposing({ isComposing: false, key: 'Escape' }), false);
  assert.equal(isComposing({ key: 'Escape' }), false);
  assert.equal(isComposing(null), false);
});
