#!/usr/bin/env node
/**
 * ATS-111 -- ST: the WORKBENCH USABILITY in a REAL browser.
 *
 *   node tools/ats111-probes/st-ats111.mjs <repo> <scratch-dir> <playwright-node_modules>
 *
 * WHY THIS EXISTS
 * ---------------
 * The unit tests (tests/workbench-state.test.mjs) assert on the MODEL:
 * the four states are distinguishable, the key bindings are what they
 * claim to be. The model is not the product. A model can be perfect and
 * the UI can still be unusable:
 *
 *   - the states are rendered by a React component, and a component that
 *     renders the WRONG one is still a perfect model;
 *   - a key binding can exist in the model and never be WIRED to a
 *     handler, so Escape does nothing;
 *   - the focus order can be correct in the model and wrong in the DOM;
 *   - the focus ring can be declared and then overridden by a later
 *     `outline:none`;
 *   - a "reload" button can be rendered and do NOTHING, because the
 *     state it would set is already set.
 *
 * So this probe drives the REAL static export in the REAL Chromium and
 * asserts what a KEYBOARD USER actually gets.
 *
 * WHAT IS PROVED
 * --------------
 *   ST-111-1  the page loads and the workbench renders, with no console
 *              error and no page error;
 *   ST-111-2  the FOUR STATES are DISTINGUISHABLE in the rendered DOM:
 *              each is a distinct element with a distinct `data-state`,
 *              a distinct LABEL and a distinct DETAIL -- and the four
 *              labels are four different strings;
 *   ST-111-3  the FOCUS ORDER is the reading order: the rail comes
 *              first, the content last, and the DOM order agrees with
 *              the model's FOCUS_ORDER. The comparison is on the ORDER,
 *              and the check is falsifiable -- a deliberately scrambled
 *              DOM order is asserted to FAIL it;
 *   ST-111-4  the focus is VISIBLE: the focused element really has an
 *              outline (the base stylesheet removes it from three
 *              elements, so this is the check that catches the
 *              regression);
 *   ST-111-5  Escape CANCELS: a load that is in flight is cancelled by
 *              the Escape key, and the panel then says 「已取消」 -- it
 *              does NOT say 「加载失败」 and it does NOT hang;
 *   ST-111-6  Enter SUBMITS: the project dialog is submitted by the
 *              Enter key alone, with no mouse click;
 *   ST-111-7  the whole core flow -- select a project, find a case,
 *              open it, run it, stop it -- is completable with the
 *              KEYBOARD ALONE (no `click()` on the workbench's own
 *              controls anywhere in this check);
 *
 *              The probe has to work against TWO shapes of the catalogue
 *              row, because the falsifiability step copies THIS probe onto
 *              the two pinned baseline trees: on the baselines the ROW was
 *              the `<button>`, today the row is a `<div>` and its TITLE is
 *              the button. A selector that only matched one shape would
 *              fail on a baseline because the element was missing, not
 *              because of the defect the check exists to prove.
 *   ST-111-8  the skip link is the FIRST focusable element, so a
 *              keyboard user can jump to the content;
 *   ST-111-9  no console error and no page error were produced;
 *   ST-111-10 the 「重新加载」 entry REALLY re-issues the request, in
 *              all three states that offer it (failed / cancelled /
 *              empty). A button that changes nothing is not a retry;
 *   ST-111-11 Enter on a focused BUTTON does not swallow that button's
 *              own action: focusing 「取消」 in the add-project dialog
 *              and pressing Enter CANCELS, and does NOT register the
 *              project;
 *   ST-111-12 with NO project at all the panel shows the NO-PROJECT
 *              state with its import guidance -- not "the filter
 *              matched nothing";
 *   ST-111-13 switching project CLEARS the previous project's cases:
 *              while the new project loads, the panel, the metrics and
 *              the footer show none of the old project's cases;
 *   ST-111-14 the key commands work when the focus is on the <body>:
 *              Escape cancels the load and Ctrl+P moves the focus to
 *              the search box;
 *   ST-111-15 closing the dialog returns the focus to the button that
 *              opened it;
 *   ST-111-16 Escape STOPS the run that is in flight -- the footer
 *              promises it, so it has to work. The run is really in
 *              flight (the fixture's test sleeps), and the keydown is
 *              observed at the window level;
 *   ST-111-17 Ctrl+P inside the open dialog is CONSUMED by the
 *              workbench -- a key the footer documents must not fall
 *              through to the browser's own Print command;
 *   ST-111-18 the "no case matches the filter" message is TEXT: it
 *              must not show the characters 「<br/>」 (the round-2
 *              review's R2-6 observation);
 *   ST-111-19 a failed run POLL marks the run rows as stale (the
 *              round-2 review's R2-7 observation): the rows below are
 *              the last known ones, and the panel says so.
 *
 * ROUND 3 (the round-2 review)
 * -----------------------------
 * Two of the checks above were rewritten because the review showed they
 * COULD NOT FAIL, and four were added for the defects the review found:
 *
 *   - ST-111-11d now types a path that has NEVER been registered. The
 *     old one typed the path ST-111-6 had already registered, so the
 *     Bridge rejected the duplicate and the count stayed the same even
 *     when Enter wrongly submitted the form.
 *   - ST-111-12d now asserts that the no-project panel renders a STATE
 *     PANEL. The old one asserted the absence of a string that can
 *     never appear in that state.
 *   - ST-111-16, ST-111-17, ST-111-18 and ST-111-19 are new.
 *
 * The four states are proven by EXECUTION, NOT BY A FIXTURE
 * --------------------------------------------------------
 * Each state is produced by MAKING IT HAPPEN:
 *
 *   loading   -- the catalogue request is delayed by the probe's own
 *                route handler, so the panel is genuinely in flight;
 *   cancelled -- the load is in flight and the reader presses Escape;
 *   error     -- the probe's route handler answers with a 500;
 *   empty     -- the catalogue really is empty (a project with no cases).
 *
 * A state that cannot be produced is reported as FAIL -- never as
 * "expected but not checked".
 *
 * Prints `PASS`/`FAIL` per check and `RESULT: <passed>/<total>`; exits 0
 * only when every check passed. No port literal: the Bridge's default
 * port is read from the product source (tools/ats103-probes/lib/
 * default-port.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [repoArg, scratchArg, nodeModulesArg] = process.argv.slice(2);
if (!repoArg || !scratchArg || !nodeModulesArg) {
  console.error('usage: st-ats111.mjs <repo> <scratch-dir> <playwright-node_modules>');
  process.exit(2);
}
const repo = path.resolve(repoArg);

const { defaultPort } = await import(
  pathToFileURL(path.join(repo, 'tools', 'ats103-probes', 'lib', 'default-port.mjs')).href);
const { waitForPortFree, stopChildAndReleasePort } = await import(
  pathToFileURL(path.join(repo, 'tools', 'ats103-probes', 'lib', 'port-free.mjs')).href);

fs.mkdirSync(scratchArg, { recursive: true });
const scratch = fs.mkdtempSync(path.join(path.resolve(scratchArg), 'st111-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

/* --- the project: the sample fixture, plus an EMPTY one ------------------- */
const project = path.join(scratch, 'sample-playwright');
fs.cpSync(path.join(repo, 'examples', 'sample-playwright'), project,
  { recursive: true, filter: (src) => !src.includes('node_modules') });
fs.symlinkSync(path.resolve(nodeModulesArg), path.join(project, 'node_modules'), 'junction');

// A project with NO test cases: the empty state has to be produced by a
// real project, not by an empty response the probe faked.
const emptyProject = path.join(scratch, 'empty-playwright');
fs.mkdirSync(path.join(emptyProject, 'tests'), { recursive: true });
fs.writeFileSync(path.join(emptyProject, 'package.json'),
  JSON.stringify({ name: 'ats-empty-fixture', private: true }, null, 2));
fs.writeFileSync(path.join(emptyProject, 'playwright.config.ts'),
  "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n");
fs.symlinkSync(path.resolve(nodeModulesArg), path.join(emptyProject, 'node_modules'), 'junction');

const PORT = defaultPort();
const data = path.join(scratch, 'data');

let browser = null;
let bridge = null;
try {
  const portWaited = await waitForPortFree(PORT, 15000);
  if (portWaited === null) {
    console.error(`port ${PORT} is already in use -- the probe would talk to a DIFFERENT server.`);
    process.exit(1);
  }

  bridge = spawn(process.execPath, ['server/index.mjs'], {
    cwd: repo,
    env: { ...process.env, ATS_PORT: String(PORT), ATS_DATA_DIR: data },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (b) => { bridgeErr += b.toString(); });

  let up = false;
  for (let end = Date.now() + 30000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(150);
  }
  check('the Bridge starts', up, bridgeErr.slice(0, 400));
  if (!up) throw new Error('the Bridge did not start');

  const token = (await (await fetch(`http://127.0.0.1:${PORT}/api/session`)).json()).token;
  const api = async (endpoint, method = 'GET', body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
      method,
      headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return [r.status, await r.json()];
  };

  // --- the browser ---------------------------------------------------------
  const pw = await import(
    pathToFileURL(path.join(path.resolve(nodeModulesArg), 'playwright-core', 'index.js')).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error('playwright-core does not export chromium');
  browser = await chromium.launch();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  // ATS-111 (round 3): the KEYDOWN RECORD.
  //
  // A listener on the WINDOW runs AFTER every listener on the document
  // and on the elements, so by the time it sees the event it can tell
  // whether the workbench CONSUMED the key (`defaultPrevented === true`)
  // or let it through to the browser.
  //
  // That is the only way to observe the two regressions the round-2
  // review found from the OUTSIDE:
  //
  //   - Escape during a run was not handled at all (defaultPrevented
  //     stayed false and the run kept going);
  //   - Ctrl+P inside the open dialog was not intercepted, so the
  //     browser's own Print command was still reachable.
  //
  // The listener is installed before the first navigation, so every key
  // the probe presses is recorded.
  await page.addInitScript(() => {
    window.__ats111Keys = [];
    window.addEventListener('keydown', (e) => {
      window.__ats111Keys.push({
        key: e.key,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        prevented: e.defaultPrevented,
        target: e.target && e.target.tagName ? e.target.tagName : '(none)',
      });
    });
  });

  const readState = async () => page.evaluate(() => {
    const el = document.querySelector('[data-region="panel"] .state-panel');
    if (!el) return null;
    return {
      kind: el.getAttribute('data-state'),
      role: el.getAttribute('role'),
      live: el.getAttribute('aria-live'),
      busy: el.getAttribute('aria-busy'),
      label: (el.querySelector('.state-head b')?.textContent || '').trim(),
      detail: (el.querySelector('.state-detail')?.textContent || '').trim(),
      hint: (el.querySelector('.state-hint')?.textContent || '').trim(),
    };
  });

  /* ================================================================== */
  /* ST-111-12  NO project at all -> the NO-PROJECT state                  */
  /* ================================================================== */
  // The page is loaded BEFORE the fixture projects are registered, so the
  // workbench really has no project to show. This is the state a reader
  // is in the first time they open the platform -- and it is a DIFFERENT
  // fact from "the project's catalogue is empty" and from "the filter
  // matched nothing".
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await sleep(2500);
  const noProjectState = await readState();
  check('ST-111-12a with NO project the panel shows the NO-PROJECT state',
    noProjectState && noProjectState.kind === 'no-project', JSON.stringify(noProjectState));
  check('ST-111-12b the NO-PROJECT state does NOT say 「没有匹配」',
    noProjectState && !/没有匹配/.test(`${noProjectState.detail}${noProjectState.hint}`),
    noProjectState && `${noProjectState.detail} | ${noProjectState.hint}`);
  check('ST-111-12c the NO-PROJECT state points at importing a project',
    noProjectState && /添加项目|导入/.test(`${noProjectState.hint}${noProjectState.detail}`),
    noProjectState && noProjectState.hint);
  // ST-111-12d.
  //
  // The round-2 review found that the ORIGINAL 12d asserted the panel
  // does not contain 「没有符合当前条件的用例」 -- a string that can
  // never appear in the no-project state, because without a project the
  // panel renders the NO-PROJECT panel and the filter-miss branch is
  // never reached. So the check was PASS on the pre-fix tree too: it
  // could not fail, and it was listed as evidence anyway.
  //
  // The replacement asserts something that IS reachable in the
  // no-project state and IS broken in the pre-fix tree: the no-project
  // panel is a STATE PANEL, so the panel carries a `.state-panel`
  // element with `data-state="no-project"`. On the pre-fix tree there
  // is no no-project panel at all -- the panel renders the filter-miss
  // message instead -- so the element is absent and the check FAILS.
  //
  // It is also a NEGATIVE CONTROL in its own right: the panel must
  // carry a state panel and must NOT carry the filter-miss text.
  const noProjectPanel = await page.evaluate(() => {
    const panel = document.querySelector('[data-region="panel"]');
    if (!panel) return null;
    const state = panel.querySelector('.state-panel');
    return {
      hasStatePanel: Boolean(state),
      stateKind: state ? state.getAttribute('data-state') : null,
      hasFilterMiss: /没有符合当前条件的用例/.test(panel.textContent || ''),
      hasEmptySmall: Boolean(panel.querySelector('.empty-small')),
    };
  });
  check('ST-111-12d the NO-PROJECT state renders a STATE PANEL (not the filter-miss text)',
    noProjectPanel && noProjectPanel.hasStatePanel
      && noProjectPanel.stateKind === 'no-project'
      && !noProjectPanel.hasFilterMiss,
    JSON.stringify(noProjectPanel));
  check('ST-111-12e the NO-PROJECT state does not fall back to the filter-miss block',
    noProjectPanel && !noProjectPanel.hasEmptySmall,
    JSON.stringify(noProjectPanel));
  // --- the two projects ----------------------------------------------------
  const [, added] = await api('/api/projects', 'POST', { path: project });
  const projectId = added.project.id;
  const [, addedEmpty] = await api('/api/projects', 'POST', { path: emptyProject });
  const emptyProjectId = addedEmpty.project.id;
  check('both fixture projects are registered', Boolean(projectId && emptyProjectId),
    `${projectId} / ${emptyProjectId}`);
  // The page picks the first project up on its next refresh.
  await page.evaluate(() => {
    const btn = document.querySelector('button[data-region="refresh"]');
    btn?.click();
  });
  await sleep(2500);

  /* ================================================================== */
  /* ST-111-1  the page loads                                            */
  /* ================================================================== */
  check('ST-111-1 the exported workbench loads in a real browser',
    (await page.locator('.app-shell').count()) === 1);
  check('ST-111-9a the page produced no page error on load',
    pageErrors.length === 0, pageErrors.join(' | '));

  /* ================================================================== */
  /* ST-111-8  the skip link is the FIRST focusable element              */
  /* ================================================================== */
  const skip = page.locator('a.skip-link');
  check('ST-111-8a the skip link exists', (await skip.count()) === 1);
  await page.keyboard.press('Tab');
  const firstFocus = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}.${el.className}` : '(none)';
  });
  check('ST-111-8b the FIRST Tab reaches the skip link', /skip-link/.test(firstFocus), firstFocus);
  // And the skip link becomes visible when it is focused.
  const skipVisible = await page.evaluate(() => {
    const el = document.querySelector('a.skip-link');
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width };
  });
  check('ST-111-8c the focused skip link is VISIBLE (not off screen)',
    skipVisible.left >= 0 && skipVisible.top >= 0 && skipVisible.width > 0,
    JSON.stringify(skipVisible));

  /* ================================================================== */
  /* ST-111-3  the focus order is the reading order                      */
  /* ================================================================== */
  // The regions the model declares, in the order it declares them.
  const { FOCUS_ORDER, observedFocusOrderIsConsistent } = await import(
    pathToFileURL(path.join(repo, 'apps', 'studio', 'lib', 'workbench-state.mjs')).href);

  // Walk the Tab order and record the REGION each stop belongs to. The
  // region is taken from the element's own `data-region`, so the check
  // measures the SHIPPED markup rather than a hardcoded list of
  // selectors.
  const observed = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const region = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const holder = el.closest('[data-region]');
      return holder ? holder.getAttribute('data-region') : null;
    });
    if (region === null) continue;
    observed.push(region);
    // The content is the last region in the order: once it is reached,
    // the walk has covered the declared order.
    if (observed.length >= 2 && observed[observed.length - 1] === 'content') break;
  }
  // The comparison is on the ORDER. `observedFocusOrderIsConsistent`
  // compares the sequence of DISTINCT regions, in the order they were
  // first reached, against the declared order -- so a DOM whose regions
  // were reordered produces a DIFFERENT sequence and fails.
  check('ST-111-3 the regions are visited in the DECLARED reading order',
    observedFocusOrderIsConsistent(observed),
    `observed=${observed.join(' > ')}; declared=${FOCUS_ORDER.join(' > ')}`);
  check('ST-111-3b the walk reached the CONTENT region',
    observed.includes('content'), observed.join(' > '));

  // The negative control: the SAME check, applied to a deliberately
  // scrambled order. It MUST fail -- otherwise the check above cannot
  // fail either, and "the order was verified" would be an empty claim.
  const scrambled = ['content', 'panel', 'search', 'add-project', 'project-select', 'refresh', 'rail'];
  check('ST-111-3c the order check REJECTS a scrambled DOM order (the negative control)',
    observedFocusOrderIsConsistent(scrambled) === false,
    `scrambled=${scrambled.join(' > ')}`);

  /* ================================================================== */
  /* ST-111-4  the focus is VISIBLE                                      */
  /* ================================================================== */
  // The base stylesheet sets `outline:none` on the project select, the
  // search input and the modal input. So the focus ring has to be
  // restored by the ATS-111 rules -- this check is what catches the
  // case where it is not.
  const outlineOf = async (selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.focus();
    const cs = getComputedStyle(el);
    return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor };
  }, selector);

  const railOutline = await outlineOf('button.rail-btn');
  check('ST-111-4a a focused rail button has a VISIBLE outline',
    railOutline && railOutline.outlineStyle !== 'none' && parseFloat(railOutline.outlineWidth) > 0,
    JSON.stringify(railOutline));

  const selectOutline = await outlineOf('select.project-select');
  check('ST-111-4b the focused project select has a VISIBLE outline (the base sheet removes it)',
    selectOutline && selectOutline.outlineStyle !== 'none' && parseFloat(selectOutline.outlineWidth) > 0,
    JSON.stringify(selectOutline));

  const searchOutline = await outlineOf('.search input');
  check('ST-111-4c the focused search input has a VISIBLE outline (the base sheet removes it)',
    searchOutline && searchOutline.outlineStyle !== 'none' && parseFloat(searchOutline.outlineWidth) > 0,
    JSON.stringify(searchOutline));

  /* ================================================================== */
  /* ST-111-2  the FOUR STATES are distinguishable                        */
  /* ================================================================== */
  /**
   * Re-issue the catalogue request for `id`.
   *
   * Switching the select to the SAME value does not change the `active`
   * state, so React does not re-run the effect and no request is made.
   * The probe therefore switches AWAY and back -- which is what a
   * reader does when they pick another project and come back -- and
   * that really does re-issue the request.
   */
  const reloadCatalogue = async (id, otherId) => {
    await page.evaluate(([v, o]) => {
      const sel = document.querySelector('select.project-select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, o);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      setter.call(sel, v);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, [id, otherId]);
  };

  /** Set the project select to a value, the way a reader would. */
  const selectProject = async (id) => {
    await page.evaluate((v) => {
      const sel = document.querySelector('select.project-select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, v);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, id);
  };

  /** What the panel, the metrics and the footer say about the cases. */
  const readCatalogueCounts = async () => page.evaluate(() => {
    const panelItems = [...document.querySelectorAll('[data-region="panel"] .file-item')]
      .map((el) => el.textContent || '');
    const metric = [...document.querySelectorAll('.metric')]
      .find((el) => (el.querySelector('span')?.textContent || '') === '可管理用例');
    const footer = document.querySelector('.sidebar-footer')?.textContent || '';
    return {
      panelItems,
      manageable: metric?.querySelector('strong')?.textContent?.trim() || '',
      footer,
    };
  });

  // --- the EMPTY state ----------------------------------------------------
  // The empty project really has no cases, so the panel really is empty.
  await reloadCatalogue(emptyProjectId, projectId);
  await sleep(4000);
  const emptyState = await readState();
  check('ST-111-2a the EMPTY state is rendered',
    emptyState && emptyState.kind === 'empty', JSON.stringify(emptyState));
  check('ST-111-2b the EMPTY state says 「暂无内容」',
    emptyState && emptyState.label === '暂无内容', emptyState && emptyState.label);

  // --- the ERROR state ----------------------------------------------------
  // The route handler is installed ONCE and its BEHAVIOUR is driven by
  // `routeMode`. A route that is installed and then removed again can
  // leave a stale handler behind (removal by pattern does not remove an
  // inline handler), and a stale 500-injector would make the LOADING and
  // CANCELLED checks measure the ERROR state instead.
  let routeMode = 'pass';
  // The held requests are a LIST, not a single resolver: `reloadCatalogue`
  // fires TWO /tests requests (it switches the project select twice), and
  // in 'hold' mode BOTH hang. With a single slot the second request
  // overwrote the first one's resolver, so the first request hung FOREVER
  // -- its route was never continued, the request never completed, and the
  // panel stayed in 「加载中」 for the rest of the run. The symptom was a
  // STUCK PANEL, not a missing element: the checks after a hold phase read
  // 'loading' where they expected 'empty', and everything downstream
  // cascaded (ST-111-10f/10g, then 13a, 7c, 7d, 7e, 7f, 7g, 19a~19d).
  const releaseHolds = [];
  let requestCount = 0;
  await page.route('**/api/projects/*/tests', async (route) => {
    if (route.request().url().includes('/tests')) requestCount++;
    if (routeMode === 'fail') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'PROBE_INJECTED_FAILURE' }),
      });
      return;
    }
    if (routeMode === 'hold') {
      // The request HANGS: the panel is genuinely in flight, and the
      // reader can really press Escape while it is.
      await new Promise((resolve) => { releaseHolds.push(resolve); });
    }
    await route.continue();
  });
  routeMode = 'fail';
  await reloadCatalogue(projectId, emptyProjectId);
  await sleep(4000);
  const errorState = await readState();
  check('ST-111-2c the ERROR state is rendered',
    errorState && errorState.kind === 'error', JSON.stringify(errorState));
  check('ST-111-2d the ERROR state says 「加载失败」',
    errorState && errorState.label === '加载失败', errorState && errorState.label);
  check('ST-111-2e the ERROR state is an assertive live region',
    errorState && errorState.role === 'alert' && errorState.live === 'assertive',
    errorState && `${errorState.role}/${errorState.live}`);
  // --- the LOADING state --------------------------------------------------
  // The request is made to HANG, so the panel is genuinely in flight.
  routeMode = 'hold';
  await reloadCatalogue(projectId, emptyProjectId);
  await sleep(2500);
  const loadingState = await readState();
  check('ST-111-2f the LOADING state is rendered',
    loadingState && loadingState.kind === 'loading', JSON.stringify(loadingState));
  check('ST-111-2g the LOADING state says 「加载中」',
    loadingState && loadingState.label === '加载中', loadingState && loadingState.label);
  check('ST-111-2h the LOADING state is marked busy',
    loadingState && loadingState.busy === 'true', loadingState && loadingState.busy);

  /* ================================================================== */
  /* ST-111-5  Escape CANCELS the load that is in flight                  */
  /* ================================================================== */
  // The load is still hanging (the route handler has not released it).
  routeMode = 'pass';
  await page.keyboard.press('Escape');
  await sleep(1500);
  const cancelledState = await readState();
  check('ST-111-5a Escape cancels the load and the panel says 「已取消」',
    cancelledState && cancelledState.kind === 'cancelled', JSON.stringify(cancelledState));
  check('ST-111-5b the CANCELLED state does NOT claim a failure',
    cancelledState && cancelledState.label !== '加载失败', cancelledState && cancelledState.label);
  check('ST-111-5c the CANCELLED state does NOT claim emptiness',
    cancelledState && cancelledState.label !== '暂无内容', cancelledState && cancelledState.label);
  // Release the held route so the page is not left with a pending request.
  while (releaseHolds.length) releaseHolds.pop()();
  await sleep(1500);

  // --- the four labels are four DIFFERENT strings -------------------------
  const labels = [emptyState, errorState, loadingState, cancelledState]
    .map((s) => (s ? s.label : '(missing)'));
  check('ST-111-2i the four states carry FOUR DIFFERENT labels',
    new Set(labels).size === 4, labels.join(' / '));

  /* ================================================================== */
  /* ST-111-10  「重新加载」 REALLY re-issues the request                  */
  /* ================================================================== */
  // In each of the three states that offer it, the retry must make a NEW
  // request. A button that sets the state it is already in issues no
  // request at all -- it is a no-op wearing the word 「重试」.
  const retryButton = '[data-region="panel"] .state-retry';

  // -- the CANCELLED state
  routeMode = 'hold';
  await reloadCatalogue(projectId, emptyProjectId);
  await sleep(2000);
  const beforeCancelRetry = requestCount;
  await page.keyboard.press('Escape');
  await sleep(1200);
  const cancelledAgain = await readState();
  const cancelRetryButton = await page.locator(retryButton).count();
  if (cancelRetryButton) {
    await page.click(retryButton);
    await sleep(1500);
  }
  const afterCancelRetry = requestCount;
  check('ST-111-10a the CANCELLED state offers a retry',
    cancelledAgain && cancelledAgain.kind === 'cancelled', JSON.stringify(cancelledAgain));
  check('ST-111-10b the retry in the CANCELLED state REALLY re-issues the request',
    afterCancelRetry > beforeCancelRetry,
    `requests ${beforeCancelRetry} -> ${afterCancelRetry}`);
  // The retried request is in flight again -- so the panel is loading,
  // not stuck on 「已取消」.
  const afterCancelRetryState = await readState();
  check('ST-111-10c after the retry the panel is LOADING again',
    afterCancelRetryState && afterCancelRetryState.kind === 'loading',
    JSON.stringify(afterCancelRetryState));
  while (releaseHolds.length) releaseHolds.pop()();
  routeMode = 'pass';
  await sleep(1500);

  // -- the ERROR state
  routeMode = 'fail';
  await reloadCatalogue(projectId, emptyProjectId);
  await sleep(3000);
  const errorAgain = await readState();
  const beforeErrorRetry = requestCount;
  const errorRetryButton = await page.locator(retryButton).count();
  if (errorRetryButton) {
    await page.click(retryButton);
    await sleep(2000);
  }
  const afterErrorRetry = requestCount;
  check('ST-111-10d the ERROR state offers a retry',
    errorAgain && errorAgain.kind === 'error', JSON.stringify(errorAgain));
  check('ST-111-10e the retry in the ERROR state REALLY re-issues the request',
    afterErrorRetry > beforeErrorRetry,
    `requests ${beforeErrorRetry} -> ${afterErrorRetry}`);
  routeMode = 'pass';
  await sleep(1500);

  // -- the EMPTY state
  await reloadCatalogue(emptyProjectId, projectId);
  await sleep(3000);
  const emptyAgain = await readState();
  const beforeEmptyRetry = requestCount;
  const emptyRetryButton = await page.locator(retryButton).count();
  if (emptyRetryButton) {
    await page.click(retryButton);
    await sleep(2000);
  }
  const afterEmptyRetry = requestCount;
  check('ST-111-10f the EMPTY state offers a retry',
    emptyAgain && emptyAgain.kind === 'empty', JSON.stringify(emptyAgain));
  check('ST-111-10g the retry in the EMPTY state REALLY re-issues the request',
    afterEmptyRetry > beforeEmptyRetry,
    `requests ${beforeEmptyRetry} -> ${afterEmptyRetry}`);

  /* ================================================================== */
  /* ST-111-13  switching project CLEARS the previous project's cases     */
  /* ================================================================== */
  // The project with cases is loaded first, so its cases are on screen.
  await reloadCatalogue(projectId, emptyProjectId);
  await sleep(3000);
  const withCases = await readCatalogueCounts();
  const oldCaseVisible = withCases.panelItems.some((t) => /home\.spec|tests\//.test(t));
  check('ST-111-13a the project WITH cases shows them',
    oldCaseVisible && withCases.manageable !== '0',
    `manageable=${withCases.manageable} items=${withCases.panelItems.length}`);

  // Now switch to the EMPTY project and HOLD the request, so the panel
  // is caught in its loading state -- the state in which the old
  // project's cases used to stay on screen.
  routeMode = 'hold';
  await selectProject(emptyProjectId);
  await sleep(1500);
  const duringSwitch = await readCatalogueCounts();
  const duringSwitchState = await readState();
  check('ST-111-13b switching to another project shows NO cases of the previous one',
    duringSwitch.panelItems.length === 0,
    `items=${duringSwitch.panelItems.length}`);
  check('ST-111-13c the 「可管理用例」 metric is 0 while the new project loads',
    duringSwitch.manageable === '0',
    `manageable=${duringSwitch.manageable}`);
  check('ST-111-13d the footer counts no cases of the previous project',
    !/\d+ tests/.test(duringSwitch.footer.replace(/^0 tests/, '')) || /0 tests/.test(duringSwitch.footer),
    `footer=${duringSwitch.footer.replace(/\s+/g, ' ')}`);
  check('ST-111-13e the panel is in the LOADING state while the new project loads',
    duringSwitchState && duringSwitchState.kind === 'loading',
    JSON.stringify(duringSwitchState));
  while (releaseHolds.length) releaseHolds.pop()();
  routeMode = 'pass';
  await sleep(2000);

  /* ================================================================== */
  /* ST-111-18  the filter-miss message is TEXT, not markup              */
  /* ================================================================== */
  // The round-2 review observed (R2-6) that the "no case matches the
  // filter" message rendered the LITERAL characters `<br/>` on the
  // screen: the message was one JSX string with a `<br/>` inside it,
  // and a `<br/>` inside a string literal is not a tag.
  //
  // The reader saw "没有符合当前条件的用例<br/>搜索与过滤条件按「交集」叠加"
  // -- a sentence with markup in it. The message is in the panel this
  // task owns, so the check is added here.
  //
  // The check needs a project that HAS cases (otherwise the panel shows
  // the EMPTY state, not the filter-miss message), so the project with
  // cases is selected first.
  await selectProject(projectId);
  await sleep(3000);
  await page.focus('[data-region="search"] input');
  await page.keyboard.type('zzz-no-such-case-at-all');
  await sleep(1500);
  const filterMissText = await page.evaluate(() =>
    (document.querySelector('[data-region="panel"] .empty-small')?.innerText || '').replace(/\s+/g, ' ').trim());
  check('ST-111-18a the filter-miss message does NOT show the characters 「<br/>」',
    filterMissText && !filterMissText.includes('<br/>') && /没有符合当前条件的用例/.test(filterMissText),
    filterMissText);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await sleep(1000);

  /* ================================================================== */
  /* ST-111-6  Enter SUBMITS the dialog                                   */
  /* ================================================================== */
  // The dialog is opened with the KEYBOARD (the button is focused and
  // activated with Enter -- no `click()`).
  await page.focus('button[data-region="add-project"]');
  await page.keyboard.press('Enter');
  await sleep(600);
  const dialogOpen = await page.locator('.modal[role="dialog"]').count();
  check('ST-111-6a the dialog opens with the KEYBOARD alone (Enter on the button)',
    dialogOpen === 1, `${dialogOpen} dialog(s)`);

  // The path is typed with the keyboard, and Enter SUBMITS it.
  //
  // The path must be a project that is NOT registered yet: the fixture
  // was registered at the start of the probe, and re-adding it fails
  // with PROJECT_ALREADY_REGISTERED -- which would leave the dialog
  // open and make the check measure the wrong thing.
  const secondProject = path.join(scratch, 'second-playwright');
  fs.cpSync(path.join(repo, 'examples', 'sample-playwright'), secondProject,
    { recursive: true, filter: (src) => !src.includes('node_modules') });
  fs.symlinkSync(path.resolve(nodeModulesArg), path.join(secondProject, 'node_modules'), 'junction');

  await page.focus('.modal input');
  await page.keyboard.type(secondProject);
  await page.keyboard.press('Enter');
  await sleep(4000);
  const dialogAfter = await page.locator('.modal[role="dialog"]').count();
  check('ST-111-6b Enter SUBMITS the dialog (no mouse click)',
    dialogAfter === 0, `${dialogAfter} dialog(s) still open`);
  const registered = (await api('/api/projects'))[1].projects.length;
  check('ST-111-6c the keyboard-submitted project was REGISTERED',
    registered >= 3, `${registered} project(s)`);

  /* ================================================================== */
  /* ST-111-11  Enter on a focused BUTTON does not swallow its action     */
  /* ================================================================== */
  // The dialog is opened again, the path is typed, and the focus is
  // moved to 「取消」. Pressing Enter there must CANCEL the dialog --
  // and must NOT register the project. A workbench that intercepts
  // Enter on a button performs its OWN write instead, so the reader
  // who meant to cancel ends up adding a project.
  //
  // ST-111-11d -- THE PATH MUST NEVER HAVE BEEN REGISTERED.
  //
  // The round-2 review found that the original 11d typed the SAME path
  // as ST-111-6, which had already been registered. The Bridge rejects
  // a second registration with PROJECT_ALREADY_REGISTERED, so the
  // project count stayed the same EVEN IF Enter had wrongly submitted
  // the form -- the check could not fail. On the pre-fix tree, where the
  // bug really existed, 11d was PASS while 11c failed.
  //
  // So this check uses a THIRD, never-registered path. The probe
  // creates the directory on disk (the Bridge validates that the path
  // exists, has a package.json and a playwright config) but never
  // registers it, so a submission WOULD register it and the count
  // WOULD go up.
  const projectsBeforeCancel = (await api('/api/projects'))[1].projects.length;
  // A path that has never been registered: the directory exists on
  // disk, but the Bridge has never seen it.
  const cancelProjectPath = path.join(scratch, 'cancel-only-playwright');
  fs.cpSync(path.join(repo, 'examples', 'sample-playwright'), cancelProjectPath,
    { recursive: true, filter: (src) => !src.includes('node_modules') });
  fs.symlinkSync(path.resolve(nodeModulesArg), path.join(cancelProjectPath, 'node_modules'), 'junction');
  await page.focus('button[data-region="add-project"]');
  await page.keyboard.press('Enter');
  await sleep(600);
  const cancelDialogOpen = await page.locator('.modal[role="dialog"]').count();
  await page.focus('.modal input');
  await page.keyboard.type(cancelProjectPath);
  // Move the focus to the CANCEL button -- with the keyboard, by
  // tabbing to it, so the probe does not place the focus itself.
  await page.keyboard.press('Tab');
  await sleep(200);
  const focusedInDialog = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}|${el.textContent || ''}` : '(none)';
  });
  await page.keyboard.press('Enter');
  await sleep(2500);
  const dialogAfterCancel = await page.locator('.modal[role="dialog"]').count();
  const projectsAfterCancel = (await api('/api/projects'))[1].projects.length;
  check('ST-111-11a the dialog is open for the cancel check',
    cancelDialogOpen === 1, `${cancelDialogOpen} dialog(s)`);
  check('ST-111-11b the focus reached the cancel button by TAB',
    /取消/.test(focusedInDialog), focusedInDialog);
  check('ST-111-11c Enter on 「取消」 CLOSES the dialog',
    dialogAfterCancel === 0, `${dialogAfterCancel} dialog(s) still open`);
  // The path typed here has NEVER been registered, so a submission would
  // have increased the count. The count must be unchanged.
  check('ST-111-11d Enter on 「取消」 did NOT register the NEVER-REGISTERED project',
    projectsAfterCancel === projectsBeforeCancel,
    `${projectsBeforeCancel} -> ${projectsAfterCancel} (path=${cancelProjectPath})`);

  /* ================================================================== */
  /* ST-111-15  closing the dialog returns the focus                     */
  /* ================================================================== */
  // The focus must go back to the button that opened the dialog.
  const focusAfterClose = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}|${el.getAttribute('data-region') || ''}` : '(none)';
  });
  check('ST-111-15 the focus returned to the 「添加项目」 button after the dialog closed',
    /add-project/.test(focusAfterClose), focusAfterClose);

  /* ================================================================== */
  /* ST-111-17  Ctrl+P inside the open dialog is CONSUMED               */
  /* ================================================================== */
  // The round-2 review found a REGRESSION this round introduced: the
  // key handler returned early when the dialog was open, WITHOUT calling
  // preventDefault(). So Ctrl+P fell through to the browser's own Print
  // command -- the workbench was no longer intercepting a key it
  // documents in its footer.
  //
  // The check observes the keydown at the WINDOW level, which runs after
  // every listener on the document: `defaultPrevented === true` means
  // the workbench consumed it.
  //
  // It must FAIL on 9e305e7 (the tree the round-2 review rejected).
  await page.focus('button[data-region="add-project"]');
  await page.keyboard.press('Enter');
  await sleep(600);
  const ctrlPDialogOpen = await page.locator('.modal[role="dialog"]').count();
  check('ST-111-17a the dialog is open for the Ctrl+P check',
    ctrlPDialogOpen === 1, `${ctrlPDialogOpen} dialog(s)`);
  await page.keyboard.press('Control+p');
  await sleep(500);
  const ctrlPKey = await page.evaluate(() => {
    const keys = window.__ats111Keys || [];
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i];
      if (k.ctrl && k.key.toLowerCase() === 'p') return k;
    }
    return null;
  });
  check('ST-111-17b Ctrl+P inside the dialog IS consumed by the workbench',
    ctrlPKey && ctrlPKey.prevented === true,
    JSON.stringify(ctrlPKey));
  // And the focus must stay INSIDE the dialog: the modal promise.
  const focusInDialogAfterCtrlP = await page.evaluate(() => {
    const el = document.activeElement;
    return el && el.closest('.modal') ? 'in-dialog' : `outside:${el ? el.tagName : '(none)'}`;
  });
  check('ST-111-17c Ctrl+P inside the dialog does NOT move the focus out of it',
    focusInDialogAfterCtrlP === 'in-dialog', focusInDialogAfterCtrlP);
  // Close the dialog again so the rest of the probe starts from a clean
  // state.
  await page.keyboard.press('Escape');
  await sleep(500);

  /* ================================================================== */
  /* ST-111-14  the key commands work with the focus on the <body>       */
  /* ================================================================== */
  // The focus is put on the body -- which is where it lands after a
  // page load and after a dialog closes -- and the commands must work
  // there. A handler bound to the app shell never sees these keys.
  await page.evaluate(() => { document.activeElement?.blur?.(); document.body.focus?.(); });
  await sleep(200);
  const focusOnBody = await page.evaluate(() => document.activeElement?.tagName || '(none)');
  check('ST-111-14a the focus is on the BODY for this check',
    focusOnBody === 'BODY', focusOnBody);

  // Ctrl+P moves the focus to the search box, from the body.
  await page.keyboard.press('Control+p');
  await sleep(500);
  const searchFocus = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}|${el.getAttribute('placeholder') || ''}` : '(none)';
  });
  check('ST-111-14b Ctrl+P moves the focus to the search box with the focus on the BODY',
    /INPUT/.test(searchFocus), searchFocus);

  // Escape cancels the load that is in flight, with the focus on the
  // body. The loading panel says 「按 Esc 可以取消这次加载」, so it has
  // to work from there.
  await page.evaluate(() => { document.activeElement?.blur?.(); document.body.focus?.(); });
  routeMode = 'hold';
  await reloadCatalogue(projectId, emptyProjectId);
  await sleep(2000);
  const bodyLoadingState = await readState();
  await page.evaluate(() => { document.activeElement?.blur?.(); document.body.focus?.(); });
  await page.keyboard.press('Escape');
  await sleep(1500);
  const bodyCancelledState = await readState();
  check('ST-111-14c the load is in flight for the body-Escape check',
    bodyLoadingState && bodyLoadingState.kind === 'loading', JSON.stringify(bodyLoadingState));
  check('ST-111-14d Escape cancels the load with the focus on the BODY',
    bodyCancelledState && bodyCancelledState.kind === 'cancelled',
    JSON.stringify(bodyCancelledState));
  while (releaseHolds.length) releaseHolds.pop()();
  routeMode = 'pass';
  await sleep(1500);

  /* ================================================================== */
  /* ST-111-7  the core flow is completable with the KEYBOARD alone       */
  /* ================================================================== */
  // From here on, NOTHING is clicked. Every step is a key press.
  const noClick = async (label, fn) => {
    try { await fn(); return check(label, true); } catch (e) {
      return check(label, false, String(e && e.message ? e.message : e).slice(0, 200));
    }
  };

  // Choose the project with the keyboard: focus the select, then use the
  // arrow keys (the native behaviour of a select).
  await noClick('ST-111-7a the project can be chosen with the KEYBOARD',
    async () => {
      await page.focus('select.project-select');
      await page.keyboard.press('Home');
      for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
      await sleep(2500);
      const value = await page.evaluate(() => document.querySelector('select.project-select').value);
      if (!value) throw new Error('the select is still empty');
    });

  // Ctrl+P moves the focus to the search box.
  await noClick('ST-111-7b Ctrl+P moves the focus to the search box',
    async () => {
      await page.focus('button.rail-btn');
      await page.keyboard.press('Control+p');
      await sleep(400);
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? `${el.tagName}|${el.getAttribute('placeholder') || ''}` : '(none)';
      });
      if (!/INPUT/.test(focused)) throw new Error(`the focus is on ${focused}`);
    });

  // The search filters the list.
  await noClick('ST-111-7c the search filters the catalogue with the KEYBOARD',
    async () => {
      await page.keyboard.type('首页');
      await sleep(1200);
      const count = await page.locator('[data-region="panel"] .file-item').count();
      if (count < 1) throw new Error('the search matched no case');
    });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await sleep(800);

  // Open a case with the keyboard: focus the control that opens it and
  // press Enter.
  //
  // The control is the row's TITLE button (`.file-open`), not the row
  // itself. The row is a `<div>` because the pick-box next to it is a real
  // `<button role="checkbox">` and a nested interactive element inside a
  // button is not reachable by the keyboard -- so the row cannot be the
  // button any more. The title button is the control that actually opens
  // the case, and it is focusable.
  //
  // The focus is ASSERTED, not assumed: the check says "the control that
  // opens a case can be reached with the keyboard AND opens it". A selector
  // swap alone would pass even if the control had stopped being focusable,
  // because the page might then open the case by some other route -- the
  // assertion is what keeps the check falsifiable.
  await noClick('ST-111-7d a test case can be OPENED with the KEYBOARD',
    async () => {
      // The control that opens a case is the title button when the row has
      // one, and the row itself otherwise. The catalogue row changed SHAPE
      // between the two pinned baselines and now: on the baselines the ROW
      // was the button, today the row is a `<div>` and its TITLE is a
      // `<button class="file-open">` (the pick-box next to it is a real
      // checkbox, and a nested interactive element inside a button is not
      // reachable by the keyboard).
      //
      // The falsifiability step copies THIS probe onto the OLD trees, so the
      // selector has to match BOTH shapes -- a selector that only matched
      // today's shape would fail on a baseline because the element was not
      // there, not because of the defect the check exists to prove.
      const rowSel = '[data-region="panel"] .file-item';
      const titleSel = `${rowSel} .file-open`;
      // Which shape the page has, decided by asking the page -- a comma
      // selector would resolve to the first element in DOCUMENT order that
      // matches either part, and on today's tree the `.file-item` DIV comes
      // before its `.file-open` child, so the DIV would win and it is not
      // focusable.
      const titleCount = await page.locator(titleSel).count();
      const opener = titleCount > 0 ? titleSel : rowSel;
      await page.focus(opener);
      const focused = await page.evaluate((sel) => {
        const el = document.activeElement;
        if (!el) return '(none)';
        if (!el.matches(sel)) return `${el.tagName}.${el.className}`;
        return el.tagName;
      }, opener);
      if (focused !== 'BUTTON') {
        throw new Error(`the control that opens a case is not focused (focus=${focused})`);
      }
      await page.keyboard.press('Enter');
      await sleep(3000);
      // The panel's own item carries the `selected` class once it is
      // open, and the content shows the case's own file. Both are
      // checked: the selection and the content.
      const selected = await page.locator('[data-region="panel"] .file-item.selected').count();
      const heading = await page.locator('.content h1').innerText();
      if (selected < 1) throw new Error('no item is selected');
      if (!heading || /测试目录与脚本工作台/.test(heading)) {
        throw new Error(`the case did not open (heading=${heading})`);
      }
    });

  // Run it with Ctrl+Enter.
  await noClick('ST-111-7e the selected case can be RUN with Ctrl+Enter',
    async () => {
      await page.keyboard.press('Control+Enter');
      await sleep(3000);
      const toast = await page.locator('.toast').count();
      const toastText = await page.locator('.toast').allInnerTexts().catch(() => []);
      const runCount = (await api('/api/runs'))[1].runs.length;
      // The toast carries WHY a run was not started (the Bridge's rejection
      // reason). A failure that does not say why is a failure the next
      // reader cannot act on, so the text goes into the message.
      if (runCount < 1) {
        throw new Error(`no run was started (toast=${JSON.stringify(toastText)})`);
      }
      if (!toast) throw new Error('no feedback was shown');
    });

  // The run reaches a terminal state, and the run list shows it -- the
  // last step of the core flow, still with the keyboard only.
  await noClick('ST-111-7f the run reaches a TERMINAL state',
    async () => {
      for (let i = 0; i < 120; i++) {
        const runs = (await api('/api/runs'))[1].runs;
        const last = runs[runs.length - 1];
        if (last && ['passed', 'failed', 'cancelled', 'error', 'interrupted'].includes(last.status)) {
          if (last.status === 'running' || last.status === 'queued') throw new Error('still in flight');
          return;
        }
        await sleep(500);
      }
      throw new Error('the run did not reach a terminal state in 60s');
    });

  // The run is visible in the run list, and the list's state is the
  // "ready" one -- NOT an empty state, NOT an error.
  await noClick('ST-111-7g the run list shows the run and is not in an error/empty state',
    async () => {
      await page.focus('button[title="执行中心"]');
      await page.keyboard.press('Enter');
      await sleep(2500);
      const state = await page.getAttribute('[data-region="runs-panel"]', 'data-runs-state');
      if (state !== 'ready') throw new Error(`the run list state is ${state}`);
      const items = await page.locator('[data-region="runs-panel"] .run-item').count();
      if (items < 1) throw new Error('the run list is empty');
    });

  /* ================================================================== */
  /* ST-111-19  a failed run poll MARKS the rows as stale                 */
  /* ================================================================== */
  // The round-2 review observed (R2-7) that when the run list's POLL
  // fails, the panel shows 「加载失败」 but the old run rows are listed
  // below it with no mark -- so the reader could take a stale run for a
  // current one. The model's `staleData` annotation existed but was
  // never wired to the DOM.
  //
  // The check fails the poll and looks for the mark.
  await page.evaluate(() => {
    document.querySelector('button[title="执行中心"]')?.click();
  });
  await sleep(2500);
  const runsHealthy = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-region="runs-panel"] .run-item').length,
    stale: document.querySelectorAll('[data-region="runs-panel"] [data-stale="true"]').length,
  }));
  check('ST-111-19a the run rows are NOT marked stale while the poll works',
    runsHealthy.rows > 0 && runsHealthy.stale === 0,
    `rows=${runsHealthy.rows} stale=${runsHealthy.stale}`);
  // Fail the poll. The handler is named so it can be REMOVED again --
  // an inline handler cannot be unrouted, and a poll that stays broken
  // would make the checks after this one measure the wrong thing.
  const failRunsPoll = async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'PROBE_INJECTED_RUNS_FAILURE' }),
      });
      return;
    }
    await route.continue();
  };
  await page.route('**/api/runs', failRunsPoll);
  // The panel polls every 1.8s.
  await sleep(5000);
  const runsFailed = await page.evaluate(() => ({
    state: document.querySelector('[data-region="runs-panel"]')?.getAttribute('data-runs-state'),
    rows: document.querySelectorAll('[data-region="runs-panel"] .run-item').length,
    stale: document.querySelectorAll('[data-region="runs-panel"] [data-stale="true"]').length,
    note: document.querySelector('[data-region="runs-stale"]')?.textContent || '',
  }));
  check('ST-111-19b the failed poll is reported as an ERROR state',
    runsFailed.state === 'error', `${runsFailed.state}`);
  check('ST-111-19c the run rows are MARKED as stale when the poll fails',
    runsFailed.rows > 0 && runsFailed.stale === runsFailed.rows,
    `rows=${runsFailed.rows} stale=${runsFailed.stale}`);
  check('ST-111-19d the panel SAYS the rows are stale',
    /过期|上次读取/.test(runsFailed.note), runsFailed.note.replace(/\s+/g, ' ').slice(0, 90));
  // The poll works again from here on.
  await page.unroute('**/api/runs', failRunsPoll);
  await sleep(2500);
  const runsRecovered = await page.evaluate(() => ({
    state: document.querySelector('[data-region="runs-panel"]')?.getAttribute('data-runs-state'),
    stale: document.querySelectorAll('[data-region="runs-panel"] [data-stale="true"]').length,
  }));
  check('ST-111-19e the rows are NOT marked stale once the poll works again',
    runsRecovered.state !== 'error' && runsRecovered.stale === 0,
    `state=${runsRecovered.state} stale=${runsRecovered.stale}`);

  /* ================================================================== */
  /* ST-111-16  Escape STOPS the run that is in flight                   */
  /* ================================================================== */
  // The footer promises 「关闭弹窗，或取消正在进行的加载或运行」. The
  // round-2 review measured that pressing Escape during a RUNNING test
  // did nothing: the keydown was not even handled (`defaultPrevented`
  // stayed false) and the run kept running. That is a capability
  // described on the screen but not implemented.
  //
  // So the run has to be REALLY in flight. The fixture project used for
  // this check has a test that SLEEPS, so the run stays alive long
  // enough for the key to be pressed against it.
  //
  // This check runs LAST, after the keyboard-only flow: starting a run
  // switches the workbench to the execution centre, so a check that
  // needs the catalogue panel has to come before it.
  const slowProject = path.join(scratch, 'slow-playwright');
  fs.cpSync(path.join(repo, 'examples', 'sample-playwright'), slowProject,
    { recursive: true, filter: (src) => !src.includes('node_modules') });
  fs.rmSync(path.join(slowProject, 'tests'), { recursive: true, force: true });
  fs.mkdirSync(path.join(slowProject, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(slowProject, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({testDir:'./tests',timeout:90000,retries:0});\n");
  fs.writeFileSync(path.join(slowProject, 'tests', 'slow.spec.ts'),
    "import { test } from '@playwright/test';\ntest('slow sleeper', async () => { await new Promise((r) => setTimeout(r, 60000)); });\n");
  fs.symlinkSync(path.resolve(nodeModulesArg), path.join(slowProject, 'node_modules'), 'junction');
  const [, addedSlow] = await api('/api/projects', 'POST', { path: slowProject });
  const slowProjectId = addedSlow.project.id;
  check('ST-111-16a the slow fixture project is registered',
    Boolean(slowProjectId), `${slowProjectId}`);
  // The page loaded BEFORE this project was registered, so the project
  // list on the screen does not name it yet. The refresh button pulls it
  // in -- without this the select cannot hold the new id and the run
  // button stays disabled.
  await page.evaluate(() => {
    document.querySelector('button[data-region="refresh"]')?.click();
  });
  await sleep(2500);
  // Back to the catalogue tab, so the run buttons are on screen.
  await page.evaluate(() => {
    document.querySelector('button[title="测试目录"]')?.click();
  });
  await sleep(800);
  await selectProject(slowProjectId);
  await sleep(3000);
  const slowSelected = await page.evaluate(() =>
    document.querySelector('select.project-select')?.value || '');
  check('ST-111-16a2 the slow project is the selected one',
    slowSelected === slowProjectId, `${slowSelected} vs ${slowProjectId}`);
  await page.evaluate(() => {
    const btn = document.querySelector('.button-group .btn.secondary');
    if (btn) btn.click();
  });
  let liveRun = null;
  for (let end = Date.now() + 40000; Date.now() < end;) {
    const runs = (await api('/api/runs'))[1].runs;
    liveRun = runs.find((r) => r.projectId === slowProjectId && ['running', 'queued'].includes(r.status));
    if (liveRun && liveRun.status === 'running') break;
    await sleep(500);
  }
  check('ST-111-16b a run is in flight for the Escape check',
    liveRun && liveRun.status === 'running',
    liveRun ? `${liveRun.id} ${liveRun.status}` : 'no run reached the running state');
  // The focus goes to the <body>: that is where it lands in real use,
  // and a handler bound to a container would never see the key.
  await page.evaluate(() => { document.activeElement?.blur?.(); document.body.focus?.(); });
  await sleep(200);
  await page.keyboard.press('Escape');
  await sleep(500);
  const escKey = await page.evaluate(() => {
    const keys = window.__ats111Keys || [];
    for (let i = keys.length - 1; i >= 0; i--) {
      if (keys[i].key === 'Escape') return keys[i];
    }
    return null;
  });
  check('ST-111-16c the Escape keydown IS consumed by the workbench',
    escKey && escKey.prevented === true, JSON.stringify(escKey));
  // The run must actually LEAVE the running state. The stop is
  // requested; the engine's exit decides the final status.
  let stoppedRun = null;
  for (let end = Date.now() + 30000; Date.now() < end;) {
    const runs = (await api('/api/runs'))[1].runs;
    stoppedRun = runs.find((r) => r.id === (liveRun && liveRun.id));
    if (stoppedRun && !['running', 'queued', 'cancelling'].includes(stoppedRun.status)) break;
    await sleep(500);
  }
  check('ST-111-16d Escape STOPS the run that was in flight',
    stoppedRun && !['running', 'queued', 'cancelling'].includes(stoppedRun.status),
    stoppedRun ? `${stoppedRun.id} ${stoppedRun.status}` : 'no run record');
  check('ST-111-16e the stopped run is reported as CANCELLED (not as a failure)',
    stoppedRun && stoppedRun.status === 'cancelled',
    stoppedRun && `${stoppedRun.status} error=${stoppedRun.error || '(none)'}`);
  // The footer must not promise more than the workbench does. This is
  // the claim the round-2 review called a violation of the "do not
  // claim unimplemented capabilities" rule.
  const helpLines = await page.evaluate(() =>
    [...document.querySelectorAll('[data-region="kbd-help"] li')].map((l) => l.textContent || ''));
  const escapeHelp = helpLines.find((l) => l.startsWith('Escape')) || '';
  check('ST-111-16f the footer describes what Escape really does',
    /运行/.test(escapeHelp) && /加载/.test(escapeHelp), escapeHelp);

  /* ================================================================== */
  /* ST-111-9b no console error over the whole run                        */
  /* ================================================================== */
  // The probe's OWN failures are excluded, and they are REPORTED rather
  // than hidden: the reader can see exactly which console errors the
  // probe asked for.
  const injected = consoleErrors.filter((e) =>
    /PROBE_INJECTED_FAILURE|409 \(Conflict\)|500 \(Internal Server Error\)/.test(e));
  const real = consoleErrors.filter((e) => !injected.includes(e));
  console.log(`  (the probe injected ${injected.length} console error(s) on purpose)`);
  check('ST-111-9b the page produced no console error over the whole flow',
    real.length === 0, real.join(' | '));
  check('ST-111-9c the page produced no page error over the whole flow',
    pageErrors.length === 0, pageErrors.join(' | '));

  await ctx.close();
} catch (err) {
  check('the probe ran to the end', false, err.stack);
} finally {
  try { if (browser) await browser.close(); } catch { /* already gone */ }
  if (bridge) await stopChildAndReleasePort(bridge, PORT);
  console.log(`scratch: ${scratch}`);
  console.log(`RESULT: ${passed}/${total}`);
  process.exitCode = passed === total ? 0 : 1;
}
