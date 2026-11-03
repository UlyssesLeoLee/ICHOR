import { test, expect } from '@playwright/test';
test('首页响应正常 @REQ-001', async ({ page }) => {
  await page.goto('https://example.com/');
  await expect(page).toHaveTitle(/Example Domain/);
  await expect(page.getByRole('heading',{name:'Example Domain'})).toBeVisible();
});
test('导航入口正常 @REQ-002', async ({ page }) => {
  await page.goto('https://example.com/');
  await page.getByRole('link',{name:'More information...'}).click();
  await expect(page).toHaveURL(/iana.org/);
});
