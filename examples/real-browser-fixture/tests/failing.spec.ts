import { test, expect } from '@playwright/test';
import { EXPECTED_FAILURE_TEXT, FAILING_TITLE } from './constants';

/**
 * ATS-107 真实浏览器夹具 —— 故意失败的用例。
 *
 * 这条用例断言一个页面上**并不存在**的文本，于是引擎会用自己的断言错误
 * 把它判为失败。这条用例存在的意义是给出验收口径里的那个 FAIL，以及
 * **引擎自己的错误信息**：探针要证明 Bridge 报出来的失败原因，就是引擎
 * 报出来的那一条，而不是 Bridge 自己重写的一句。
 */
test(FAILING_TITLE, async ({ page }) => {
  await page.setContent('<main id="target">ATS-107 PASS</main>');
  await expect(page.locator('#target')).toHaveText(EXPECTED_FAILURE_TEXT);
});
