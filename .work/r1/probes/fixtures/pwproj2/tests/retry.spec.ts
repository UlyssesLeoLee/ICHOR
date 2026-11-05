import { test, expect } from '@playwright/test';
test('flaky: fails first try then passes', async ({}, testInfo) => {
  expect(testInfo.retry, 'first attempt failed').toBeGreaterThan(0);
});
