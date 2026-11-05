import { test, expect } from '@playwright/test';

/**
 * ATS-301 fixture: a self-contained Playwright test.
 *
 * It deliberately does NOT reach the network -- it sets the page content
 * itself -- so the adapter's IT runs are deterministic and can run on a
 * machine without internet access. The browser is still a REAL Chromium
 * process, which is what the `nativeBrowser` capability is about.
 *
 * The first case PASSES and the second one FAILS on purpose: the adapter's
 * result mapping has to be able to tell the two apart, and the ATS-301
 * acceptance criterion is exactly "at least one PASS and one FAIL".
 *
 * The test titles are referenced by .aitest/traceability.json, so they must
 * not change.
 */
test('首页响应正常 @REQ-001', async ({ page }) => {
  await page.setContent('<h1 id="t">hello</h1>');
  await expect(page.locator('#t')).toHaveText('hello');
});
test('导航入口正常 @REQ-002', async ({ page }) => {
  await page.setContent('<h1>actual</h1>');
  // Deliberate mismatch: this case must FAIL.
  await expect(page.locator('#t')).toHaveText('expected-mismatch');
});
