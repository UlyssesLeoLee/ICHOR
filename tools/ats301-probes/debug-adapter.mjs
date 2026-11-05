#!/usr/bin/env node
/**
 * ATS-301 debug helper: run one adapter start() and dump what happened.
 *
 * Usage: node tools/ats301-probes/debug-adapter.mjs playwright|wdio
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const which = process.argv[2] || 'playwright';

const { createPlaywrightAdapter } = await import('../../server/adapters/playwright.mjs');
const { createWdioAdapter } = await import('../../server/adapters/wdio.mjs');

const fixture = which === 'wdio'
  ? path.join(REPO, 'examples', 'sample-wdio')
  : path.join(REPO, 'examples', 'sample-playwright');

const adapter = which === 'wdio' ? createWdioAdapter() : createPlaywrightAdapter();
const project = { id: `proj_${which}`, root: fixture };
const out = path.join(os.tmpdir(), `ats301-debug-${which}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

console.log(`=== debug ${which} ===`);
console.log(`fixture: ${fixture}`);
console.log(`out    : ${out}`);
console.log('');

const handle = adapter.start({ project, run: {}, file: null, outputDir: out });
console.log(`args   : ${JSON.stringify(handle.args)}`);
console.log('');

const code = await new Promise((resolve) => {
  handle.child.on('close', (c) => resolve(c));
  setTimeout(() => resolve('TIMEOUT'), 120000);
});
console.log(`exit code : ${code}`);
console.log('');

console.log('--- files in the output dir ---');
const walk = (dir, depth = 0) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    console.log(`  ${'  '.repeat(depth)}${name}${st.isDirectory() ? '/' : ` (${st.size} bytes)`}`);
    if (st.isDirectory() && depth < 2) walk(full, depth + 1);
  }
};
walk(out);
console.log('');

const collected = adapter.collect({ outputDir: out });
console.log('--- collect() ---');
console.log(JSON.stringify(collected, null, 2).slice(0, 2500));
