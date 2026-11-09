import { test, expect } from '@playwright/test';
import { PASSING_TITLE } from './constants';

/**
 * ATS-107 真实浏览器夹具 —— 故意通过的用例。
 *
 * 这条用例在**离线**的页面上断言一个自己刚刚写进去的文本：它不需要网络，
 * 也不依赖任何外部服务，所以它的结论只取决于「引擎真的跑起来了吗」。
 *
 * 它存在的意义是给出验收口径里的那个 PASS：一条 PASS 如果不是因为引擎
 * 判定通过而出现，Chromium 上「至少 1 PASS 1 FAIL」这条口径就没有被证明。
 */
test(PASSING_TITLE, async ({ page }) => {
  await page.setContent('<main id="target">ATS-107 PASS</main>');
  await expect(page.locator('#target')).toHaveText('ATS-107 PASS');
});
