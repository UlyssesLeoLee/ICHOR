/**
 * The NEGATIVE CONTROL of the ATS-107 probe.
 *
 *   node tools/ats107-probes/mutation-check.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * The probe of ATS-107 compares the Bridge's report with a direct CLI run.
 * A comparison that is only ever fed ONE honest result cannot be shown to
 * work: it would just as happily accept a dishonest one. A probe that
 * always prints PASS would look exactly like a delivery.
 *
 * So this control feeds the comparison MUTATED results and requires it to
 * notice EVERY mutation. The comparison lives in `compare.mjs` -- the same
 * module the probe imports -- so the control exercises exactly the code
 * that accepts or rejects the product.
 *
 * NOTHING HERE TOUCHES THE PRODUCT. The mutations are applied to an
 * in-memory COPY of the projection the Bridge would report.
 *
 * The control prints `PASS`/`FAIL` per mutation and `RESULT: <passed>/<total>`;
 * it exits 0 only when every mutation was caught AND the honest result was
 * accepted.
 */
import {
  compareVerdicts, compareError, compareExpectations, compareCounters,
  cliCounts, verdictToStatus,
} from './compare.mjs';

let passed = 0;
let total = 0;
const check = (id, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` -- ${detail}` : ''}`);
};

/* --- the honest result, as the CLI and the Bridge both reported it ------- */
const EXPECTED_TEXT = 'ATS-107 FAIL — this text is intentionally absent';
const CLI_ERROR = `Error: expect(locator).toHaveText(expected) failed\n\nLocator:  locator('#target')\nExpected: "${EXPECTED_TEXT}"\nReceived: "ATS-107 PASS"`;

const cliCases = [
  {
    title: 'ATS-107 failing case asserts a text that is absent',
    file: 'tests/failing.spec.ts',
    engineStatus: 'unexpected',
    expectedStatus: 'passed',
    resultStatus: 'failed',
    error: CLI_ERROR,
    attachments: ['error-context', 'trace'],
  },
  {
    title: 'ATS-107 passing case renders the offline page',
    file: 'tests/passing.spec.ts',
    engineStatus: 'expected',
    expectedStatus: 'passed',
    resultStatus: 'passed',
    error: '',
    attachments: ['trace'],
  },
];

const expected = {
  cases: [
    { title: 'ATS-107 failing case asserts a text that is absent', status: 'failed' },
    { title: 'ATS-107 passing case renders the offline page', status: 'passed' },
  ],
};

const honestBridge = {
  summary: {
    passed: 1, failed: 1, skipped: 0, flaky: 0, total: 2, executions: 2,
    cases: [
      { title: 'ATS-107 failing case asserts a text that is absent', status: 'failed', error: CLI_ERROR },
      { title: 'ATS-107 passing case renders the offline page', status: 'passed', error: '' },
    ],
  },
};

/** A deep copy, so a mutation never touches the honest result. */
const clone = (v) => JSON.parse(JSON.stringify(v));

/* --- the honest result must be ACCEPTED ---------------------------------- */
{
  const s = honestBridge.summary;
  check('the honest result is accepted by the verdict comparison',
    compareVerdicts(cliCases, s.cases).length === 0);
  check('the honest result is accepted by the error comparison',
    compareError(cliErrorOf(cliCases), CLI_ERROR, EXPECTED_TEXT).length === 0);
  check('the honest result is accepted by the expectation comparison',
    compareExpectations(s.cases, expected).length === 0);
  check('the honest result is accepted by the counter comparison',
    compareCounters(s, cliCounts(cliCases)).length === 0);
}

/** The CLI's error message, taken from the CLI's own case. */
function cliErrorOf(cases) {
  return cases.find((c) => verdictToStatus(c.engineStatus) === 'failed')?.error ?? '';
}

/* --- the mutations: every one of them must be CAUGHT --------------------- */
const mutations = [
  {
    id: 'M1 the Bridge counts the failing case as passed',
    apply: (b) => { b.summary.cases[0].status = 'passed'; },
    detect: (b) => compareVerdicts(cliCases, b.summary.cases).length > 0,
  },
  {
    id: 'M2 the Bridge reports 2 passed / 0 failed',
    apply: (b) => {
      b.summary.cases[0].status = 'passed';
      b.summary.passed = 2; b.summary.failed = 0;
    },
    detect: (b) => compareCounters(b.summary, cliCounts(cliCases)).length > 0
      || compareVerdicts(cliCases, b.summary.cases).length > 0,
  },
  {
    id: 'M3 the Bridge swaps the two cases\' verdicts',
    apply: (b) => {
      const t = b.summary.cases[0].status;
      b.summary.cases[0].status = b.summary.cases[1].status;
      b.summary.cases[1].status = t;
    },
    detect: (b) => compareVerdicts(cliCases, b.summary.cases).length > 0,
  },
  {
    id: 'M4 the Bridge drops the error message',
    apply: (b) => { b.summary.cases[0].error = ''; },
    detect: (b) => compareError(CLI_ERROR, b.summary.cases[0].error, EXPECTED_TEXT).length > 0,
  },
  {
    id: 'M5 the Bridge rewrites the error message into its own wording',
    apply: (b) => { b.summary.cases[0].error = 'the case failed'; },
    detect: (b) => compareError(CLI_ERROR, b.summary.cases[0].error, EXPECTED_TEXT).length > 0,
  },
  {
    id: 'M6 the Bridge reports the right counts but the wrong per-case verdicts',
    apply: (b) => { b.summary.cases[1].status = 'failed'; },
    detect: (b) => compareVerdicts(cliCases, b.summary.cases).length > 0,
  },
  {
    id: 'M7 the Bridge\'s verdicts differ from the fixture\'s declared expectations',
    apply: (b) => { b.summary.cases[0].status = 'passed'; },
    detect: (b) => compareExpectations(b.summary.cases, expected).length > 0,
  },
  {
    id: 'M8 the Bridge loses a case entirely',
    apply: (b) => { b.summary.cases.pop(); },
    detect: (b) => compareVerdicts(cliCases, b.summary.cases).length > 0,
  },
  {
    id: 'M9 the Bridge reports a case that the CLI did not run',
    apply: (b) => {
      b.summary.cases.push({ title: 'a case the CLI never ran', status: 'passed', error: '' });
    },
    detect: (b) => compareVerdicts(cliCases, b.summary.cases).length > 0,
  },
  {
    id: 'M10 the Bridge reports a wrong total',
    apply: (b) => { b.summary.total = 3; },
    detect: (b) => compareCounters(b.summary, cliCounts(cliCases)).length > 0,
  },
];

for (const m of mutations) {
  const b = clone(honestBridge);
  m.apply(b);
  const caught = m.detect(b);
  check(`the mutation is caught -- ${m.id}`, caught,
    caught ? 'the comparison noticed' : 'the comparison ACCEPTED the mutation');
}

console.log(`RESULT: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
