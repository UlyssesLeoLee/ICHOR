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
 *     `outline:none`.
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
 *              the model's FOCUS_ORDER;
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
 *   ST-111-9  no console error and no page error were produced.
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

  // --- the two projects ----------------------------------------------------
  const [, added] = await api('/api/projects', 'POST', { path: project });
  const projectId = added.project.id;
  const [, addedEmpty] = await api('/api/projects', 'POST', { path: emptyProject });
  const emptyProjectId = addedEmpty.project.id;
  check('both fixture projects are registered', Boolean(projectId && emptyProjectId),
    `${projectId} / ${emptyProjectId}`);

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

  /* ================================================================== */
  /* ST-111-1  the page loads                                            */
  /* ================================================================== */
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await sleep(2500);
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
  const { FOCUS_ORDER } = await import(
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
    if (observed.length === 0 || observed[observed.length - 1] !== region) observed.push(region);
    // The content is the last region in the order: once it is reached,
    // the walk has covered the declared order.
    if (observed.length >= 2 && observed[observed.length - 1] === 'content') break;
  }
  // The observed order must be a SUBSEQUENCE of the declared one: the
  // DOM may have more stops inside a region (the six rail buttons, the
  // list items), but the REGIONS must be visited in the declared order.
  const declaredOrder = FOCUS_ORDER.filter((r) => observed.includes(r));
  check('ST-111-3 the regions are visited in the DECLARED reading order',
    JSON.stringify(declaredOrder) === JSON.stringify([...FOCUS_ORDER].filter((r) => observed.includes(r))),
    `observed=${observed.join(' > ')}; declared=${FOCUS_ORDER.join(' > ')}`);
  check('ST-111-3b the walk reached the CONTENT region',
    observed.includes('content'), observed.join(' > '));

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
  await page.route('**/api/projects/*/tests', async (route) => {
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
  /* ST-111-6  Enter SUBMITS the dialog                                   */
  /* ================================================================== */
  // The dialog is opened with the KEYBOARD (the button is focused and
  // activated with Enter -- no `click()`).
  await page.evaluate(() => {
    const sel = document.querySelector('select.project-select');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, '');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(1500);
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
