/**
 * ATS-301 fixture: a WebdriverIO spec file.
 *
 * This is the WDIO counterpart of examples/sample-playwright/tests/pass.spec.ts.
 * The adapter discovers it by extension, runs it through the shared
 * start/stop/collect API, and maps its result onto the common result model.
 *
 * It deliberately needs NO browser automation to pass: it is a plain Mocha
 * assertion. The browser capability is proven separately by the IT run that
 * drives a real Chrome (see docs/evidence/ATS-301/).
 */
describe('sample-wdio', function () {
  it('has one passing case', function () {
    if (1 + 1 !== 2) throw new Error('arithmetic is broken');
  });
});
