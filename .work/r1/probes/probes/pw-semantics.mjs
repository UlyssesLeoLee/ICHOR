// ATS-208 review probe: does the unified model agree with Playwright's own verdict?
// usage: node pw-semantics.mjs <tree> <report.json> [baseTree] [projectRoot]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [tree, reportFile, baseTree, projectRoot] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const model = await import(pathToFileURL(path.join(tree, 'server/execution/model.mjs')).href);
const { createPlaywrightAdapter } = await import(pathToFileURL(path.join(tree, 'server/adapters/playwright.mjs')).href);
const tmp = fs.mkdtempSync(path.join(path.dirname(reportFile), 'collect-'));
fs.copyFileSync(reportFile, path.join(tmp, 'report.json'));
const tip = createPlaywrightAdapter().collect({ outputDir: tmp }).summary;
let base = null;
if (baseTree) {
  const { createPlaywrightAdapter: oldAdapter } = await import(pathToFileURL(path.join(baseTree, 'server/adapters/playwright.mjs')).href);
  base = oldAdapter().collect({ outputDir: tmp }).summary;
}
// Playwright's own verdict per spec: the case is a failure if ANY project's test is 'unexpected'.
const truth = [];
(function walk(s) { for (const x of s.specs || []) truth.push({ title: x.title, tests: x.tests.map((t) => ({ project: t.projectName, status: t.status, expected: t.expectedStatus, results: t.results.map((r) => `${r.retry}:${r.status}`) })) }); for (const c of s.suites || []) walk(c); })({ suites: report.suites });

// base (ea72af0) flattened one case per RESULT in report order; slice them per spec.
function baseCasesFor(i) {
  let off = 0;
  for (let k = 0; k < i; k++) off += truth[k].tests.reduce((n, x) => n + Math.max(1, x.results.length), 0);
  const n = truth[i].tests.reduce((m, x) => m + Math.max(1, x.results.length), 0);
  return base.cases.slice(off, off + n);
}
let mismatches = 0;
for (const t of truth) {
  const c = tip.cases[truth.indexOf(t)];
  const pwFailed = t.tests.some((x) => x.status === 'unexpected');
  const pwFlaky = !pwFailed && t.tests.some((x) => x.status === 'flaky');
  const pwSkippedAll = t.tests.every((x) => x.status === 'skipped');
  const pwVerdict = pwFailed ? 'failed' : pwFlaky ? 'flaky' : pwSkippedAll ? 'skipped' : 'passed';
  const ok = c && c.status === pwVerdict;
  if (!ok) mismatches++;
  console.log(`${ok ? 'OK      ' : 'MISMATCH'} "${t.title}"`);
  console.log(`         playwright: ${t.tests.map((x) => `${x.project}=${x.status}(expected ${x.expected}) [${x.results.join(',')}]`).join('  ')}  => verdict ${pwVerdict}`);
  console.log(`         ATS-208   : case.status=${c?.status} attempts=[${c?.attempts.map((a) => `${a.retry}:${a.status}`).join(',')}]`);
  if (base) { const i = truth.indexOf(t); const sl = base.cases.filter((x, k) => true); console.log(`         base      : flattened cases for this spec: ${JSON.stringify(baseCasesFor(i).map((x) => x.status))}`); }
}
console.log('');
console.log('Playwright stats      :', JSON.stringify(report.stats && { expected: report.stats.expected, unexpected: report.stats.unexpected, flaky: report.stats.flaky, skipped: report.stats.skipped }));
console.log('ATS-208 summary (tip) :', JSON.stringify({ passed: tip.passed, failed: tip.failed, flaky: tip.flaky, skipped: tip.skipped, total: tip.total, executions: tip.executions }));
if (base) console.log('base ea72af0 summary  :', JSON.stringify({ passed: base.passed, failed: base.failed, flaky: base.flaky, skipped: base.skipped, total: base.total }));
// Attempt UID uniqueness through attemptsForRun (unbound registry -> fallback key).
const parsed = model.parseReport(report);
const attempts = model.attemptsForRun({ uid: 'run_x', projectUid: 'proj_x', projectRoot: projectRoot || null }, parsed, { version: 1, projects: {} });
const uids = attempts.map((a) => a.uid);
const dupUids = uids.filter((u, i) => uids.indexOf(u) !== i);
console.log('attempts              :', attempts.length, 'unique uids:', new Set(uids).size, dupUids.length ? `DUPLICATES ${dupUids.length}` : '');
const retry0 = attempts.filter((a) => a.title === 'fails every try in project b only').map((a) => `${a.retry}:${a.status}`);
console.log('attempts of the project-b case (retry:status):', JSON.stringify(retry0), '-- project name recorded on attempt:', JSON.stringify(attempts[0] && Object.keys(attempts[0]).includes('project')));
console.log('');
console.log(`RESULT: ${mismatches} of ${truth.length} cases disagree with Playwright's verdict`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(mismatches ? 1 : 0);
