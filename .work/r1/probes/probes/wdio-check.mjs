// ATS-208 review probe: does the WDIO side aggregate a re-executed case into ONE case (as wdio.mjs:129-132 claims)?
// usage: node wdio-check.mjs <tree>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { mergeWdioReports } = await import(pathToFileURL(path.join(process.argv[2], 'server/adapters/wdio.mjs')).href);
const report = { specs: ['file:///p/test/specs/a.e2e.js'], suites: [{ tests: [
  { name: 'same case', state: 'failed', duration: 5, error: { message: 'boom' } },
  { name: 'same case', state: 'passed', duration: 4 },
] }] };
const r = mergeWdioReports([{ report }]);
console.log(JSON.stringify({ total: r.total, flaky: r.flaky, failed: r.failed, passed: r.passed, executions: r.executions, cases: r.cases.map((c) => `${c.title}:${c.status}:${c.attemptsCount}`) }));
console.log(r.total === 1 ? 'OK   merged into one case' : 'NOTE never merged: every WDIO execution is its own case (caseKey includes executions.length), so the comment at wdio.mjs:129-132 does not hold');
