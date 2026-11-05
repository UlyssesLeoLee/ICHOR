#!/usr/bin/env node
/**
 * ATS-301 probe: how often does the WDIO adapter lose a worker report?
 *
 * The adapter merges the per-worker json reporter files. If WDIO exits
 * before every reporter has flushed its file, the merged summary would
 * silently under-report the run -- a silent data loss in the evidence of a
 * test run. This probe runs the adapter N times and reports how many cases
 * each run produced.
 *
 * Usage: node tools/ats301-probes/wdio-repeat.mjs [iterations]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const { createWdioAdapter } = await import('../../server/adapters/wdio.mjs');

const ITERATIONS = Number(process.argv[2] || 5);
const fixture = path.join(REPO, 'examples', 'sample-wdio');
const project = { id: 'proj_wdio_repeat', root: fixture };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats301-wdio-repeat-'));

console.log('=== ATS-301 WDIO repeat probe ===');
console.log(`iterations : ${ITERATIONS}`);
console.log(`fixture    : ${fixture}`);
console.log('');

const totals = [];
for (let i = 0; i < ITERATIONS; i++) {
  const out = path.join(tmp, `run-${i}`);
  fs.mkdirSync(out, { recursive: true });
  const adapter = createWdioAdapter();
  const handle = adapter.start({ project, run: {}, file: null, outputDir: out });
  const code = await new Promise((resolve) => {
    handle.child.on('close', (c) => resolve(c));
    setTimeout(() => resolve('TIMEOUT'), 120000);
  });
  const files = fs.readdirSync(out).filter((n) => n.endsWith('.json'));
  const collected = adapter.collect({ outputDir: out });
  const total = collected ? collected.summary.total : null;
  totals.push(total);
  console.log(`run ${i}: exit=${code} reporterFiles=${files.length} [${files.join(', ')}] collectedTotal=${total}`);
  if (collected) {
    console.log(`         passed=${collected.summary.passed} failed=${collected.summary.failed} unattributed=${collected.summary.unattributedCases}`);
  }
}

console.log('');
const distinct = [...new Set(totals)];
console.log(`distinct totals : ${JSON.stringify(distinct)}`);
console.log(totals.every((t) => t === 2) ? 'RESULT: stable -- every run produced both cases.' : 'RESULT: UNSTABLE -- some runs lost a worker report.');

fs.rmSync(tmp, { recursive: true, force: true });
