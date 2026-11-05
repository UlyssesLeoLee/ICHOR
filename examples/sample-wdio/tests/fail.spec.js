/**
 * ATS-301 fixture: a WebdriverIO spec file with exactly one failing case.
 *
 * Together with pass.spec.js this gives the adapter one PASS and one FAIL in
 * a single run, so the common result model can be shown to distinguish them.
 */
describe('sample-wdio', function () {
  it('has one failing case', function () {
    throw new Error('deliberate failure for the ATS-301 result-mapping fixture');
  });
});
