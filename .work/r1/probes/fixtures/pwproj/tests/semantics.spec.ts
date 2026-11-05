import { test, expect } from '@playwright/test';

test('expected failure via test.fail', async () => {
  test.fail();
  expect(1).toBe(2);
});

test('unexpected pass of a test.fail case', async () => {
  test.fail();
  expect(1).toBe(1);
});

test('fails every try in project b only', async ({}, testInfo) => {
  expect(testInfo.project.name).toBe('a');
});

test('skipped in project b only', async ({}, testInfo) => {
  test.skip(testInfo.project.name === 'b', 'not on b');
});

test('flaky: fails first try then passes', async ({}, testInfo) => {
  expect(testInfo.retry).toBeGreaterThan(0);
});
