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
 *              opened it.
 *
 * THE FOUR STATES ARE PROVEN BY EXECUTION, NOT BY A FIXTURE
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
  const noProjectBody = await page.evaluate(() =>
    document.querySelector('[data-region="panel"]')?.textContent || '');
  check('ST-111-12d the NO-PROJECT state is not the "filter matched nothing" message',
    !/没有符合当前条件的用例/.test(noProjectBody), noProjectBody.replace(/\s+/g, ' ').slice(0, 120));

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
  let releaseHold = null;
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
      await new Promise((resolve) => { releaseHold = resolve; });
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
  if (releaseHold) { releaseHold(); releaseHold = null; }
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
  if (releaseHold) { releaseHold(); releaseHold = null; }
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
  if (releaseHold) { releaseHold(); releaseHold = null; }
  routeMode = 'pass';
  await sleep(2000);

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
  const projectsBeforeCancel = (await api('/api/projects'))[1].projects.length;
  await page.focus('button[data-region="add-project"]');
  await page.keyboard.press('Enter');
  await sleep(600);
  const cancelDialogOpen = await page.locator('.modal[role="dialog"]').count();
  await page.focus('.modal input');
  await page.keyboard.type(secondProject);
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
  check('ST-111-11d Enter on 「取消」 did NOT register the project',
    projectsAfterCancel === projectsBeforeCancel,
    `${projectsBeforeCancel} -> ${projectsAfterCancel}`);

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
  if (releaseHold) { releaseHold(); releaseHold = null; }
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

  // Open a case with the keyboard: focus the first item and press Enter.
  await noClick('ST-111-7d a test case can be OPENED with the KEYBOARD',
    async () => {
      await page.focus('[data-region="panel"] .file-item');
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
      const runCount = (await api('/api/runs'))[1].runs.length;
      if (runCount < 1) throw new Error('no run was started');
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
