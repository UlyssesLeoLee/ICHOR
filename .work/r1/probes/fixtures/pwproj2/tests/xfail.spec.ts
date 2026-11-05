import { test, expect } from '@playwright/test';
test('expected failure via test.fail', async () => {
  test.fail();
  expect(1).toBe(2);
});
