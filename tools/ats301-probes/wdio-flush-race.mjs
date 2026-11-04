#!/usr/bin/env node
/**
 * ATS-301 probe: is the WDIO reporter output flushed when the CLI exits?
 *
 * The adapter merges the per-worker json reporter files. If WDIO's launcher
 * process exits before a worker has flushed its reporter file, the merged
 * summary would silently under-report the run -- a silent loss of evidence.
 *
 * This probe runs the adapter's start() and, IMMEDIATELY after the child's
 * 'close' event, counts the reporter files and reads them. It repeats the run
 * many times, sometimes several runs in PARALLEL, to reproduce the race.
 *
 * Usage: node tools/ats301-probes/wdio-flush-race.mjs [iterations] [parallel]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const { createWdioAdapter } = await import('../../server/adapters/wdio.mjs');

const ITERATIONS = Number(process.argv[2] || 6);
const PARALLEL = Number(process.argv[3] || 3);
const fixture = path.join(REPO, 'examples', 'sample-wdio');
const project = { id: 'proj_wdio_flush', root: fixture };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats301-flush-'));

console.log('=== ATS-301 WDIO flush race probe ===');
console.log(`iterations=${ITERATIONS} parallel=${PARALLEL}`);
console.log('');

async function one(i) {
  const out = path.join(tmp, `run-${i}`);
  fs.mkdirSync(out, { recursive: true });
  const adapter = createWdioAdapter();
  const handle = adapter.start({ project, run: {}, file: null, outputDir: out });
  const code = await new Promise((resolve) => {
    handle.child.on('close', (c) => resolve(c));
    setTimeout(() => resolve('TIMEOUT'), 120000);
  });
  // Count the reporter files IMMEDIATELY after close -- no grace period.
  const files = fs.readdirSync(out).filter((n) => n.endsWith('.json'));
  const collected = adapter.collect({ outputDir: out });
  return { i, code, files: files.length, total: collected ? collected.summary.total : null };
}

let short = 0;
for (let round = 0; round < ITERATIONS; round++) {
  const results = await Promise.all(
    Array.from({ length: PARALLEL }, (_, k) => one(round * PARALLEL + k)),
  );
  for (const r of results) {
    const bad = r.total !== 2;
    if (bad) short++;
    console.log(`run ${String(r.i).padStart(2)}: exit=${r.code} reporterFiles=${r.files} collectedTotal=${r.total}${bad ? '   <-- LOST A CASE' : ''}`);
  }
}

console.log('');
console.log(`runs with a lost case: ${short} / ${ITERATIONS * PARALLEL}`);
console.log(short === 0
  ? 'RESULT: no loss observed in this round.'
  : 'RESULT: the reporter output is NOT fully flushed when the CLI exits -- collect() needs to wait for it.');

fs.rmSync(tmp, { recursive: true, force: true });
