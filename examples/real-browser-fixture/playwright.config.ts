import { defineConfig } from '@playwright/test';

/**
 * ATS-107 真实浏览器夹具的配置。
 *
 * 验收口径是「Chromium 上至少 1 PASS 1 FAIL」，因此浏览器被**显式钉死**为
 * chromium：留空时由引擎默认值决定，那样这条口径就没有被证明。
 *
 * `retries: 0` 同样是有意为之：一次重试会把那条故意的失败变成 flaky 用例，
 * 而 flaky 是第四种状态，探针对账的计数器就不再是「1 通过 1 失败」。
 */
export default defineConfig({
  testDir: './tests',
  use: { browserName: 'chromium' },
  timeout: 20000,
  retries: 0,
});
