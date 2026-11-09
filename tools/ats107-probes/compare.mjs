/**
 * The comparison logic of the ATS-107 probe.
 *
 *   node tools/ats107-probes/compare.mjs   (no; it is imported)
 *
 * WHY THIS IS A SEPARATE MODULE
 * ------------------------------
 * The acceptance criterion of ATS-107 is 「结果和错误信息与 CLI 一致」 -- the
 * results and the error messages are consistent with the CLI.
 *
 * A comparison that is only ever run against ONE honest result cannot be
 * shown to work: it would also pass against a dishonest one. So the
 * comparison is factored out here, and
 * `tools/ats107-probes/mutation-check.mjs` feeds it MUTATED results and
 * requires it to notice each mutation.
 *
 * That is what makes the probe non-vacuous: the check is proved to have
 * teeth before it is used to accept the product.
 *
 * The functions are PURE: they take the two results and return the
 * differences. Nothing here reads the filesystem or starts a process, so
 * the mutation check can exercise every branch.
 */

/** The engine's verdict, mapped onto the product's vocabulary. */
export function verdictToStatus(verdict) {
  switch (verdict) {
    case 'expected': return 'passed';
    case 'unexpected': return 'failed';
    case 'flaky': return 'flaky';
    case 'skipped': return 'skipped';
    default: return 'unknown';
  }
}

/** The ANSI escape sequences the engine writes into its error message. */
export function stripAnsi(s) {
  return String(s ?? '').replace(/\[[0-9;]*m/g, '');
}

/**
 * The walk over the CLI's JSON report.
 *
 * This is deliberately NOT the product's `parseReport`: if both sides of the
 * comparison were read with the product's parser, a bug in that parser would
 * be invisible -- the two would agree precisely because they are wrong in
 * the same way. The probe therefore reads the raw facts of the report.
 */
export function walkReport(report) {
  const cases = [];
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      const file = spec.file || suite.file || '';
      for (const t of spec.tests || []) {
        const results = Array.isArray(t.results) && t.results.length ? t.results : [];
        const last = results.length ? results[results.length - 1] : null;
        cases.push({
          title: spec.title ?? '',
          file,
          engineStatus: t.status ?? null,
          expectedStatus: t.expectedStatus ?? null,
          resultStatus: last?.status ?? null,
          duration: Number.isFinite(last?.duration) ? last.duration : 0,
          error: last?.error?.message ?? '',
          attachments: (last?.attachments || []).map((a) => a.name),
        });
      }
    }
    for (const sub of suite.suites || []) walk(sub);
  };
  for (const s of report?.suites || []) walk(s);
  return { cases, stats: report?.stats ?? null };
}

/** The counts of a list of CLI cases. */
export function cliCounts(cases) {
  const list = Array.isArray(cases) ? cases : [];
  return {
    passed: list.filter((c) => verdictToStatus(c.engineStatus) === 'passed').length,
    failed: list.filter((c) => verdictToStatus(c.engineStatus) === 'failed').length,
    total: list.length,
  };
}

/** The per-case verdicts of two lists, keyed by the title. */
function byTitle(list) {
  const m = new Map();
  for (const c of list ?? []) m.set(c.title, c);
  return m;
}

/**
 * The differences between the CLI's per-case verdicts and the Bridge's.
 * An empty list means the two agree.
 */
export function compareVerdicts(cliCases, bridgeCases) {
  const diffs = [];
  const cliMap = byTitle(cliCases);
  const bridgeMap = byTitle(bridgeCases);
  if (cliMap.size !== bridgeMap.size) {
    diffs.push(`the number of cases differs: cli=${cliMap.size} bridge=${bridgeMap.size}`);
  }
  for (const [title, cc] of cliMap) {
    const bc = bridgeMap.get(title);
    if (!bc) { diffs.push(`${title}: missing on the Bridge`); continue; }
    const want = verdictToStatus(cc.engineStatus);
    if (bc.status !== want) diffs.push(`${title}: cli=${want} bridge=${bc.status}`);
  }
  for (const title of bridgeMap.keys()) {
    if (!cliMap.has(title)) diffs.push(`${title}: missing on the CLI`);
  }
  return diffs;
}

/**
 * The differences between the CLI's error messages and the Bridge's.
 *
 * The comparison is an EQUALITY check on the ANSI-stripped text, and the two
 * sides are PAIRED BY TITLE -- not "the first failing case on each side".
 * Pairing by title matters as soon as more than one case fails: the first
 * failing case of one list and the first failing case of the other may be
 * different cases, and comparing those two would report a difference that is
 * not one.
 *
 * Why equality and not containment: the criterion is 「错误信息与 CLI 一致」.
 * A containment check accepts a TRUNCATED error message -- one that keeps
 * the first line and the assertion text but drops `Received:`, the timeout
 * and the call log -- and a truncated message is not "consistent with the
 * CLI", it is a part of it. The ANSI escape sequences are not a reason to
 * weaken the check: both sides are stripped of ANSI FIRST, and what is
 * compared afterwards is the same text on both sides.
 *
 * @param {Array<{title: string, error: string}>} cliCases the CLI's cases
 * @param {Array<{title: string, error: string}>} bridgeCases the Bridge's cases
 * @returns {string[]} the differences; empty means the two agree
 */
export function compareError(cliCases, bridgeCases) {
  const diffs = [];
  const cliMap = byTitle(cliCases);
  const bridgeMap = byTitle(bridgeCases);

  // Only the cases that actually failed carry an error message.
  const failed = [...cliMap.values()].filter((c) => verdictToStatus(c.engineStatus) === 'failed');
  if (!failed.length) {
    const bridgeFailed = [...bridgeMap.values()].filter((c) => c.status === 'failed');
    if (bridgeFailed.length) {
      diffs.push(`the Bridge reports ${bridgeFailed.length} failed case(s) but the CLI reports none`);
    }
    return diffs;
  }

  for (const cc of failed) {
    const bc = bridgeMap.get(cc.title);
    if (!bc) { diffs.push(`${cc.title}: missing on the Bridge`); continue; }
    const cliText = stripAnsi(cc.error);
    const bridgeText = stripAnsi(bc.error);
    if (!bridgeText) {
      diffs.push(`${cc.title}: the Bridge carries NO error message`);
      continue;
    }
    if (cliText !== bridgeText) {
      // Name the first position that differs, so a truncated or rewritten
      // message is reported as what it is instead of a bare "not equal".
      let i = 0;
      while (i < cliText.length && i < bridgeText.length && cliText[i] === bridgeText[i]) i++;
      const cliTail = cliText.slice(i, i + 60);
      const bridgeTail = bridgeText.slice(i, i + 60);
      diffs.push(
        `${cc.title}: the error message is not the CLI's own `
        + `(cli=${cliText.length} chars, bridge=${bridgeText.length} chars; `
        + `they diverge at offset ${i}: cli=${JSON.stringify(cliTail)} bridge=${JSON.stringify(bridgeTail)})`,
      );
    }
  }
  return diffs;
}

/** The differences between the Bridge's verdicts and the fixture's expectations. */
export function compareExpectations(bridgeCases, expected) {
  const diffs = [];
  const map = byTitle(bridgeCases);
  for (const want of expected?.cases ?? []) {
    const bc = map.get(want.title);
    if (!bc) { diffs.push(`${want.title}: missing on the Bridge`); continue; }
    if (bc.status !== want.status) {
      diffs.push(`${want.title}: want=${want.status} got=${bc.status}`);
    }
  }
  return diffs;
}

/** The differences between the Bridge's counters and the CLI's counters. */
export function compareCounters(summary, counts) {
  const diffs = [];
  if ((summary?.passed ?? null) !== counts.passed) {
    diffs.push(`passed: cli=${counts.passed} bridge=${summary?.passed}`);
  }
  if ((summary?.failed ?? null) !== counts.failed) {
    diffs.push(`failed: cli=${counts.failed} bridge=${summary?.failed}`);
  }
  if ((summary?.total ?? null) !== counts.total) {
    diffs.push(`total: cli=${counts.total} bridge=${summary?.total}`);
  }
  return diffs;
}
