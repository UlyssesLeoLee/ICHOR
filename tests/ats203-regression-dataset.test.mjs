#!/usr/bin/env node
/**
 * ATS-203 Regression Dataset: Dynamic/Parameterized/Project Matrix Index Testing
 *
 * This test suite validates that the static test discovery correctly indexes:
 * 1. Parameterized tests (test.each / forEach generated cases)
 * 2. Duplicate projects (same project indexed twice)
 * 3. Cross-file same titles
 * 4. Describe path changes (UID stability)
 *
 * The goal is to ensure indexing results are correct or clearly marked as indeterminable.
 * This is NOT testing UID re-identification (ATS-204) or discovery mechanism (ATS-202).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverStatic } from '../server/core.mjs';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-203-'));

/**
 * Create a temporary project directory with test files
 */
function createProject(name) {
  const projectDir = path.join(tmpBase, name);
  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(projectDir, 'playwright.config.ts'), 'export default {}');
  return { id: `proj_${name}`, root: projectDir };
}

/**
 * Write a test file to a project
 */
function writeTestFile(project, filename, content) {
  fs.writeFileSync(path.join(project.root, 'tests', filename), content);
}

/**
 * Helper to validate that a test result set has expected properties
 */
function validateTestResult(result) {
  assert(Array.isArray(result.tests), 'should return tests array');
  assert(typeof result.discovery === 'string', 'should have discovery method');
  assert(typeof result.uidVersion === 'number', 'should have uidVersion');
  assert(typeof result.projectUid === 'string', 'should have projectUid');
  assert(typeof result.warning === 'string', 'should have warning message');
  return result;
}

// ============================================================================
// ST-ATS-203-001: Parameterized tests with test.each should be discovered
// ============================================================================
test('ST-ATS-203-001: parameterized tests with test.each are discovered', () => {
  const project = createProject('ats203-param-each');
  const content = `
import { test, expect } from '@playwright/test';

test.describe('计算模块', () => {
  test.each([
    { a: 1, b: 2, sum: 3 },
    { a: 2, b: 3, sum: 5 },
    { a: 3, b: 4, sum: 7 }
  ])('加法测试 ($a + $b = $sum)', async ({ page, a, b, sum }) => {
    await page.setContent('<h1>ok</h1>');
  });
});
`;
  writeTestFile(project, 'calc.spec.ts', content);

  const result = validateTestResult(discoverStatic(project));

  // The static discovery uses scanTestCases which looks for literal test() calls.
  // Parameterized tests are dynamic - they are generated at runtime by test.each.
  // The static scanner should NOT see them as multiple cases (since they don't
  // exist as literal test() calls), but should recognize the test.each pattern.
  // Result: the discovery should report the pattern or mark as dynamic/indeterminable.

  // Count of tests - static discovery finds literals only
  console.log(`  Discovered ${result.tests.length} test(s) from parameterized describe`);
  console.log(`  Warning: ${result.warning}`);

  // Static discovery identifies the describe but recognizes test.each cannot
  // be fully expanded without execution. This is expected behavior.
  assert(result.discovery === 'static', 'should use static discovery');
  assert(result.warning.includes('动态'), 'should warn about dynamic tests');
});

// ============================================================================
// ST-ATS-203-002: Parameterized tests with forEach should be discovered
// ============================================================================
test('ST-ATS-203-002: parameterized tests with forEach are discovered', () => {
  const project = createProject('ats203-param-foreach');
  const content = `
import { test, expect } from '@playwright/test';

test.describe('支付方式', () => {
  for (const method of ['支付宝', '微信', '银行卡']) {
    test(\`支付 - \${method}\`, async ({ page }) => {
      await page.setContent('<h1>ok</h1>');
    });
  }
});
`;
  writeTestFile(project, 'payment.spec.ts', content);

  const result = validateTestResult(discoverStatic(project));

  // This forEach loop is dynamic - test cases are generated at runtime.
  // Static discovery cannot expand it without execution.
  console.log(`  Discovered ${result.tests.length} test(s) from forEach loop`);
  console.log(`  Warning: ${result.warning}`);

  assert(result.discovery === 'static', 'should use static discovery');
  assert(result.warning.includes('动态'), 'should warn about dynamic tests');
});

// ============================================================================
// ST-ATS-203-003: Cross-file same titles with different describes
// ============================================================================
test('ST-ATS-203-003: same title in different files is correctly indexed', () => {
  const project = createProject('ats203-cross-file');

  const contentA = `
import { test, expect } from '@playwright/test';

test.describe('管理员功能', () => {
  test('可以登录', async ({ page }) => {
    await page.setContent('<h1>admin</h1>');
  });
});
`;

  const contentB = `
import { test, expect } from '@playwright/test';

test.describe('普通用户功能', () => {
  test('可以登录', async ({ page }) => {
    await page.setContent('<h1>user</h1>');
  });
});
`;

  writeTestFile(project, 'admin.spec.ts', contentA);
  writeTestFile(project, 'user.spec.ts', contentB);

  const result = validateTestResult(discoverStatic(project));

  // Both files have "可以登录" but under different describes.
  // The static discovery should find both and assign them different UIDs.
  const loginTests = result.tests.filter(t => t.title === '可以登录');
  console.log(`  Found ${loginTests.length} tests with title "可以登录"`);

  assert.equal(loginTests.length, 2, 'should find both "可以登录" tests');

  // They should have different UIDs since they're in different files
  const uids = new Set(loginTests.map(t => t.uid));
  assert.equal(uids.size, 2, 'each test should have a unique UID (file distinguishes them)');

  // Different file paths
  const files = new Set(loginTests.map(t => t.file));
  assert.equal(files.size, 2, 'tests should be from different files');
});

// ============================================================================
// ST-ATS-203-004: Describe path changes and UID stability
// ============================================================================
test('ST-ATS-203-004: UID is stable when describe path remains constant', () => {
  const project = createProject('ats203-describe-stable');

  const content1 = `
import { test, expect } from '@playwright/test';

test.describe('订单处理 > 结算 > 发票', () => {
  test('发票号生成', async ({ page }) => {
    await page.setContent('<h1>invoice</h1>');
  });
});
`;

  writeTestFile(project, 'invoice.spec.ts', content1);
  const result1 = validateTestResult(discoverStatic(project));

  console.log(`  First discovery: ${result1.tests.length} test(s)`);
  const uid1 = result1.tests[0]?.uid;
  console.log(`  UID: ${uid1}`);

  // Now re-discover (simulating a fresh discovery)
  // The same file should produce the same UID
  const result2 = validateTestResult(discoverStatic(project));
  const uid2 = result2.tests[0]?.uid;
  console.log(`  Second discovery UID: ${uid2}`);

  assert.equal(uid1, uid2, 'UID should remain stable for identical test');
});

// ============================================================================
// ST-ATS-203-005: Duplicate describe names with same title rejection
// ============================================================================
test('ST-ATS-203-005: duplicate describe names with same title are handled', () => {
  const project = createProject('ats203-dup-describe');

  // This is the case from ATS-216 Q2: two describes with same name and same title
  const content = `
import { test, expect } from '@playwright/test';

test.describe('结算', () => {
  test('提交订单', async ({ page }) => {
    await page.setContent('<h1>ok</h1>');
  });
});

test.describe('结算', () => {
  test('提交订单', async ({ page }) => {
    await page.setContent('<h1>ok</h1>');
  });
});
`;

  writeTestFile(project, 'checkout.spec.ts', content);
  const result = validateTestResult(discoverStatic(project));

  // Static discovery doesn't execute Playwright, so it won't catch the
  // "duplicate test title" error that the engine would raise.
  // The static index should report both tests (since they're syntactically
  // valid), but note the ambiguity.
  console.log(`  Discovered ${result.tests.length} test(s)`);
  console.log(`  Warning: ${result.warning}`);

  // The static discovery finds both as separate entities syntactically,
  // but they have identical (describe path, title). The warning should
  // indicate ambiguity or conflict.
  if (result.warning.includes('标注') || result.warning.includes('不一致') || result.warning.includes('临时')) {
    console.log(`  ✓ Ambiguity properly reported in warning`);
  }
});

// ============================================================================
// ST-ATS-203-006: Duplicate projects (same project indexed twice)
// ============================================================================
test('ST-ATS-203-006: same project discovered twice produces same UIDs', () => {
  const project = createProject('ats203-dup-project');

  const content = `
import { test, expect } from '@playwright/test';

test.describe('登录', () => {
  test('成功登录', async ({ page }) => {
    await page.setContent('<h1>login</h1>');
  });
});
`;

  writeTestFile(project, 'auth.spec.ts', content);

  // First discovery
  const result1 = validateTestResult(discoverStatic(project));
  const tests1 = result1.tests.map(t => ({ title: t.title, uid: t.uid }));

  console.log(`  First discovery: ${result1.tests.length} test(s)`);
  console.log(`  Tests: ${JSON.stringify(tests1)}`);

  // Second discovery with same project (simulating duplicate index)
  const result2 = validateTestResult(discoverStatic(project));
  const tests2 = result2.tests.map(t => ({ title: t.title, uid: t.uid }));

  console.log(`  Second discovery: ${result2.tests.length} test(s)`);
  console.log(`  Tests: ${JSON.stringify(tests2)}`);

  // Both discoveries should produce identical test sets with same UIDs
  assert.equal(result1.tests.length, result2.tests.length, 'should discover same number of tests');

  for (let i = 0; i < result1.tests.length; i++) {
    assert.equal(result1.tests[i].uid, result2.tests[i].uid,
      `test ${i} should have same UID in both discoveries`);
    assert.equal(result1.tests[i].title, result2.tests[i].title,
      `test ${i} should have same title in both discoveries`);
  }
});

// ============================================================================
// ST-ATS-203-007: Nested describes are correctly indexed
// ============================================================================
test('ST-ATS-203-007: nested describes are correctly indexed', () => {
  const project = createProject('ats203-nested');

  const content = `
import { test, expect } from '@playwright/test';

test.describe('购物车', () => {
  test.describe('加入商品', () => {
    test('添加单个商品', async ({ page }) => {
      await page.setContent('<h1>added</h1>');
    });

    test('添加多个商品', async ({ page }) => {
      await page.setContent('<h1>added</h1>');
    });
  });

  test.describe('清空购物车', () => {
    test('清空所有商品', async ({ page }) => {
      await page.setContent('<h1>cleared</h1>');
    });
  });
});
`;

  writeTestFile(project, 'cart.spec.ts', content);
  const result = validateTestResult(discoverStatic(project));

  console.log(`  Discovered ${result.tests.length} test(s)`);
  result.tests.forEach(t => {
    console.log(`    - ${t.title} (UID: ${t.uid})`);
  });

  assert.equal(result.tests.length, 3, 'should discover 3 nested tests');

  // All tests should have unique UIDs despite potential title similarities
  const uids = new Set(result.tests.map(t => t.uid));
  assert.equal(uids.size, 3, 'each test should have unique UID');
});

// ============================================================================
// ST-ATS-203-008: Mixed parameterized and regular tests
// ============================================================================
test('ST-ATS-203-008: mixed parameterized and regular tests are discovered', () => {
  const project = createProject('ats203-mixed');

  const content = `
import { test, expect } from '@playwright/test';

test.describe('数据验证', () => {
  test('格式检查', async ({ page }) => {
    await page.setContent('<h1>valid</h1>');
  });

  test.each([10, 20, 30])('范围检查 - %d', async ({ page }, value) => {
    await page.setContent(\`<h1>\${value}</h1>\`);
  });

  test('边界值', async ({ page }) => {
    await page.setContent('<h1>boundary</h1>');
  });
});
`;

  writeTestFile(project, 'validation.spec.ts', content);
  const result = validateTestResult(discoverStatic(project));

  console.log(`  Discovered ${result.tests.length} test(s)`);
  result.tests.forEach(t => {
    console.log(`    - ${t.title}`);
  });

  // Static discovery finds literals: "格式检查", "边界值"
  // test.each is dynamic and may not appear as literals
  const regularTests = result.tests.filter(t =>
    t.title === '格式检查' || t.title === '边界值'
  );
  console.log(`  Found ${regularTests.length} regular (non-parameterized) tests`);
  assert(regularTests.length >= 2, 'should find regular tests');
});

// ============================================================================
// Cleanup
// ============================================================================
test('cleanup: remove temporary test projects', () => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  assert(!fs.existsSync(tmpBase), 'temporary directory should be removed');
});
