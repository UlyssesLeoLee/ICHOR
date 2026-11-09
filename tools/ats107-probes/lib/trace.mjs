/**
 * Reading the BROWSER CONTEXT out of a Playwright trace archive.
 *
 * WHY THIS IS A SEPARATE MODULE
 * ------------------------------
 * The acceptance criterion of ATS-107 is 「Chromium 上至少 1 PASS 1 FAIL」.
 * A `trace.zip` on disk does NOT prove a browser was launched: a fixture
 * that never asks for a `page` still produces a trace archive, and the
 * test-runner's own trace inside it mentions the browser name in fields
 * that have nothing to do with a browser.
 *
 * What proves it is the browser context trace:
 *
 *   - the engine writes ONE trace file per browser CONTEXT, named
 *     `<n>-trace.trace` (`0-trace.trace`, `1-trace.trace`, ...);
 *   - the FIRST event of that file is a `context-options` event whose
 *     `browserName` names the browser that was actually launched.
 *
 * So: a trace archive that contains a `<n>-trace.trace` whose
 * `context-options` event says `browserName: "chromium"` is proof that a
 * real Chromium ran. An archive without one is proof that none did.
 *
 * The `test.trace` member is NOT browser-context evidence: its
 * `context-options` event belongs to the test RUNNER (its `browserName`
 * is empty), not to a browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readZipText } from './zip.mjs';

/** The member name of a browser context trace. */
const CONTEXT_TRACE = /^\d+-trace\.trace$/;

/**
 * The browser contexts a trace archive records.
 *
 * @param {string} file the `trace.zip`
 * @returns {{contexts: Array<{file: string, browserName: string, playwrightVersion: string}>,
 *            members: string[], error: string|null}}
 */
export function browserContexts(file) {
  let members;
  try {
    members = readZipText(file);
  } catch (e) {
    return { contexts: [], members: [], error: `the trace archive could not be read: ${e?.message ?? e}` };
  }
  const contexts = [];
  for (const [name, text] of members) {
    if (!CONTEXT_TRACE.test(name)) continue;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type !== 'context-options') continue;
      contexts.push({
        file: name,
        browserName: String(event.browserName ?? ''),
        playwrightVersion: String(event.playwrightVersion ?? ''),
      });
      break;
    }
  }
  return { contexts, members: [...members.keys()], error: null };
}

/**
 * The verdict on ONE trace archive: did it record a real Chromium?
 *
 * @param {string} file the `trace.zip`
 * @returns {{ok: boolean, browserName: string|null, detail: string, contexts: object[], members: string[]}}
 */
export function chromiumContext(file) {
  const { contexts, members, error } = browserContexts(file);
  if (error) {
    return { ok: false, browserName: null, detail: error, contexts, members };
  }
  const chromium = contexts.find((c) => c.browserName === 'chromium');
  if (chromium) {
    return {
      ok: true,
      browserName: 'chromium',
      detail: `${chromium.file} (playwright ${chromium.playwrightVersion})`,
      contexts,
      members,
    };
  }
  const seen = contexts.map((c) => `${c.file}:${c.browserName || '(none)'}`).join(', ');
  return {
    ok: false,
    browserName: null,
    detail: contexts.length
      ? `no browser context named chromium (contexts: ${seen})`
      : `no browser context trace in the archive (members: ${members.join(', ')})`,
    contexts,
    members,
  };
}

/**
 * The verdict over MANY trace archives: at least one of them recorded a
 * real Chromium, and -- when `every` is set -- so did all of them.
 *
 * @param {string[]} files the `trace.zip` files
 * @param {{every?: boolean}} [opts] `every`: require each archive to carry
 *   a Chromium context (used where the archive belongs to ONE case)
 * @returns {{ok: boolean, detail: string, perFile: object[]}}
 */
export function chromiumInAny(files, opts = {}) {
  const list = (files ?? []).filter((f) => fs.existsSync(f));
  if (!list.length) {
    return { ok: false, detail: 'no trace archive was found', perFile: [] };
  }
  const perFile = list.map((f) => ({ file: path.basename(path.dirname(f)) || path.basename(f), ...chromiumContext(f) }));
  const good = perFile.filter((r) => r.ok);
  if (opts.every) {
    const bad = perFile.filter((r) => !r.ok);
    return {
      ok: bad.length === 0,
      detail: bad.length
        ? `${good.length}/${perFile.length} trace archives record a Chromium context; ${bad.map((b) => `${b.file}: ${b.detail}`).join(' | ')}`
        : `all ${perFile.length} trace archives record a Chromium context`,
      perFile,
    };
  }
  return {
    ok: good.length >= 1,
    detail: good.length
      ? `${good.length}/${perFile.length} trace archives record a Chromium context (${good.map((g) => g.detail).join(', ')})`
      : `none of the ${perFile.length} trace archives records a Chromium context (${perFile.map((g) => g.detail).join(' | ')})`,
    perFile,
  };
}
