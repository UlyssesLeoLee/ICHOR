#!/usr/bin/env node
/**
 * ATS-203: the MEASURED behaviour of the index for every scenario the
 * regression dataset covers.
 *
 * The dataset must assert FACTS, so the facts are measured first. This probe
 * is the measurement: for each scenario it prints what the static index
 * (`discoverStatic`) and the authoritative index (`discoverTests` with a
 * trusted project, i.e. the real `playwright test --list`) return.
 *
 * The assertions of `tests/ats203-regression-dataset.test.mjs` (and of the
 * IT / ST files) are written against this output -- not against a guess.
 *
 * Usage: node tools/ats203-probes/measure.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
const { discoverStatic, discoverTests } = await imp('server/core.mjs');
const { withTrust, TRUST } = await imp('server/discovery/trust.mjs');

const WORK = process.env.ATS203_WORKDIR || path.join(os.tmpdir(), 'ats203-measure');
// The REAL Playwright 1.64.1 that ships with the example project. It is
// reached through a junction, so the fixture has a `node_modules` without
// installing anything.
const NM = path.join(REPO, 'examples', 'sample-playwright', 'node_modules');

let seq = 0;
function mk(name, config, files) {
  const root = path.join(WORK, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"p","private":true}');
  fs.writeFileSync(path.join(root, 'playwright.config.ts'), config);
  if (fs.existsSync(NM)) fs.symlinkSync(NM, path.join(root, 'node_modules'), 'junction');
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(root, 'tests', f), body);
  const id = 'proj_1_0123456789abcdef012345' + (++seq).toString(16).padStart(2, '0');
  return { id, uid: id, root };
}

const CFG = "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n";
const CFG_MATRIX = "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', projects: [ { name: 'chromium' }, { name: 'firefox' } ] });\n";
const CFG_ASYM = "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', projects: [ { name: 'all' }, { name: 'only-a', testMatch: /a\\.spec\\.ts/ } ] });\n";
const H = "import { test } from '@playwright/test';\n";

const pick = (t) => ({
  title: t.title,
  line: t.line,
  uidStable: t.uidStable,
  uidSource: t.uidSource,
  specIds: Array.isArray(t.specIds) ? t.specIds.length : null,
  amb: t.ambiguity?.reason ?? null,
  uid: t.uid ? t.uid.slice(-8) : null,
});

function show(label, project) {
  const s = discoverStatic(project);
  const state = withTrust({}, project, { trust: TRUST.TRUSTED });
  const a = discoverTests(project, state, { version: 1, projects: {} });
  console.log(`\n### ${label}`);
  console.log('STATIC  n=%d', s.tests.length);
  for (const t of s.tests) console.log('   ', JSON.stringify(pick(t)));
  console.log('        warning=%s', s.warning);
  console.log('AUTH    discovery=%s outcome=%s n=%d', a.discovery, a.authoritative?.outcome, a.tests.length);
  console.log('        warning=%s', a.warning);
  for (const t of a.tests) console.log('   ', JSON.stringify(pick(t)));
  if (a.authoritative?.errors?.length) console.log('        errors=%s', JSON.stringify(a.authoritative.errors.map((e) => e.message)));
  return { s, a };
}

// --- 1. a parameterised LOOP with a TEMPLATE title -------------------------
show('S1 loop + template title', mk('s1-loop-template', CFG, {
  'payment.spec.ts': H +
    "test.describe('支付方式', () => {\n  for (const method of ['支付宝', '微信', '银行卡']) {\n    test(`支付 - ${method}`, async () => {});\n  }\n});\n",
}));

// --- 2. a parameterised LOOP with a LITERAL title --------------------------
show('S2 loop + literal title', mk('s2-loop-literal', CFG, {
  'dup.spec.ts': H + "for (const x of [1, 2]) {\n  test('同名参数化', async () => {});\n}\n",
}));

// --- 3. the same title in two files ---------------------------------------
show('S3 cross-file same title', mk('s3-cross-file', CFG, {
  'admin.spec.ts': H + "test.describe('管理员功能', () => {\n  test('可以登录', async () => {});\n});\n",
  'user.spec.ts': H + "test.describe('普通用户功能', () => {\n  test('可以登录', async () => {});\n});\n",
}));

// --- 4. the same describe + the same title twice --------------------------
show('S4 same describe + same title', mk('s4-same-describe', CFG, {
  'checkout.spec.ts': H +
    "test.describe('结算', () => {\n  test('提交订单', async () => {});\n});\ntest.describe('结算', () => {\n  test('提交订单', async () => {});\n});\n",
}));

// --- 5. two DIFFERENT describes with the same title -----------------------
show('S5 different describe + same title', mk('s5-diff-describe', CFG, {
  'both.spec.ts': H +
    "test.describe('管理员功能', () => {\n  test('可以登录', async () => {});\n});\ntest.describe('普通用户功能', () => {\n  test('可以登录', async () => {});\n});\n",
}));

// --- 6. the SYMMETRIC project matrix -------------------------------------
show('S6 symmetric project matrix', mk('s6-matrix', CFG_MATRIX, {
  'a.spec.ts': H + "test('case a', async () => {});\n",
  'b.spec.ts': H + "test('case b', async () => {});\n",
}));

// --- 7. the ASYMMETRIC project matrix ------------------------------------
show('S7 asymmetric project matrix', mk('s7-asym', CFG_ASYM, {
  'a.spec.ts': H + "test('case a', async () => {});\n",
  'b.spec.ts': H + "test('case b', async () => {});\n",
}));

// --- 8. an ordinary case (the control) -----------------------------------
show('S8 ordinary case', mk('s8-plain', CFG, {
  'plain.spec.ts': H + "test('plain case', async () => {});\n",
}));

// --- 9. nested describes --------------------------------------------------
show('S9 nested describes', mk('s9-nested', CFG, {
  'cart.spec.ts': H +
    "test.describe('购物车', () => {\n  test.describe('加入商品', () => {\n    test('添加单个商品', async () => {});\n    test('添加多个商品', async () => {});\n  });\n  test.describe('清空购物车', () => {\n    test('清空所有商品', async () => {});\n  });\n});\n",
}));

// --- 10. mixed: one ordinary case + one dynamic construct ----------------
show('S10 mixed ordinary + dynamic', mk('s10-mixed', CFG, {
  'mixed.spec.ts': H +
    "test.describe('数据验证', () => {\n  test('格式检查', async () => {});\n  for (const n of [10, 20]) {\n    test(`范围检查 - ${n}`, async () => {});\n  }\n  test('边界值', async () => {});\n});\n",
}));

fs.rmSync(WORK, { recursive: true, force: true });
