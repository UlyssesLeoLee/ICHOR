#!/usr/bin/env node
/**
 * ATS-204: the matrix, against the REAL shape of the CLI's run report.
 *
 * The REAL `@playwright/test` 1.64.1 emits ONE SPEC ROW PER PROJECT: the
 * same logical case in two projects is two spec rows with two spec ids and
 * one test each. This probe feeds that real shape to the product's own
 * `parseReport` and shows what the summary says.
 *
 * Usage: node tools/ats204-probes/probe-matrix.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const { parseReport, attemptsForRun } = await import(pathToFileURL(path.join(ROOT, 'server/execution/model.mjs')).href);

/* The shape the REAL CLI writes: one spec row per (case, project).
 * The case FAILS in project beta and PASSES in project alpha. */
const realShape = {
  suites: [{
    title: 'f.spec.ts', file: 'f.spec.ts',
    specs: [
      {
        title: 'plain case', file: 'f.spec.ts', line: 4, id: 'file-half-aaaa',
        tests: [{ projectName: 'alpha', status: 'expected', expectedStatus: 'passed',
          results: [{ status: 'passed', retry: 0, duration: 10 }] }],
      },
      {
        title: 'plain case', file: 'f.spec.ts', line: 4, id: 'file-half-bbbb',
        tests: [{ projectName: 'beta', status: 'unexpected', expectedStatus: 'passed',
          results: [{ status: 'failed', retry: 0, duration: 12, error: { message: 'boom' } }] }],
      },
    ],
    suites: [],
  }],
};

/* The shape the product's OWN tests assume: one spec row, one test per project. */
const productShape = {
  suites: [{
    title: 'f.spec.ts', file: 'f.spec.ts',
    specs: [{
      title: 'plain case', file: 'f.spec.ts', line: 4, id: 'file-half-aaaa',
      tests: [
        { projectName: 'alpha', status: 'expected', expectedStatus: 'passed',
          results: [{ status: 'passed', retry: 0, duration: 10 }] },
        { projectName: 'beta', status: 'unexpected', expectedStatus: 'passed',
          results: [{ status: 'failed', retry: 0, duration: 12, error: { message: 'boom' } }] },
      ],
    }],
    suites: [],
  }],
};

for (const [label, report] of [
  ['the REAL CLI shape (one spec row per project)', realShape],
  ['the shape the product\'s tests assume (one row, many projects)', productShape],
]) {
  console.log(`=== ${label} ===`);
  const summary = parseReport(report);
  console.log(`  cases: ${summary.cases.length}`);
  for (const c of summary.cases) {
    console.log(`    title=${JSON.stringify(c.title)} line=${c.line} status=${c.status} outcome=${c.outcome} attempts=${c.attemptsCount}`);
  }
  console.log(`  counters: total=${summary.total} passed=${summary.passed} failed=${summary.failed} flaky=${summary.flaky} executions=${summary.executions}`);
  console.log('');
}

/* The binding: do the two rows of the real shape carry the SAME uid? */
const registry = {
  version: 1,
  projects: {
    proj_1_0123456789abcdef01234567: {
      version: 1,
      entries: [{
        uid: 'tc_1_d_aaaaaaaaaaaaaaaa', uidSource: 'derived', titleKey: 'plain case',
        bodyKey: 'k1', file: 'tests/f.spec.ts', title: 'plain case', line: 4, aliases: [],
        scope: [], specIds: ['file-half-aaaa', 'file-half-bbbb'],
      }],
    },
  },
};
const summary = parseReport(realShape);
const attempts = attemptsForRun(
  { uid: 'run_1_eeeeeeeeeeeeeeeeeeeeeeee', projectUid: 'proj_1_0123456789abcdef01234567', projectRoot: '/proj' },
  summary,
  registry
);
console.log('=== the binding of the two rows ===');
for (const a of attempts) {
  console.log(`    testUid=${a.testUid} basis=${a.uidBasis} status=${a.status} outcome=${a.outcome}`);
}
console.log(`  the two rows share ONE test uid: ${new Set(attempts.map((a) => a.testUid)).size === 1}`);
