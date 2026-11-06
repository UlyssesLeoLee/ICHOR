// ATS-202 round-2 reviewer probe (Opus): docs/23 §5.1 promises that a case the CLI enumerates
// "永远不会出现在 onlyStatic 里". Each case below is enumerated by the real CLI; is it ever only-static?
// Usage: node r2-scope.mjs <tree-root> <node_modules-with-@playwright/test-1.64.1> <scratch-dir>   (exit 1 on any FAIL)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [tree, nm, scratch] = process.argv.slice(2).map((p) => path.resolve(p));
const { discoverTests } = await import(pathToFileURL(path.join(tree, 'server/core.mjs')).href);
const { withTrust, TRUST } = await import(pathToFileURL(path.join(tree, 'server/discovery/trust.mjs')).href);
const { emptyRegistry } = await import(pathToFileURL(path.join(tree, 'server/uid.mjs')).href);

const SCENARIOS = {
  'S1 describe title held in a variable': [
    "const suite = 'checkout';",
    "test.describe(suite, () => {",
    "  test('pays', async () => {});",
    "});"],
  'S2 describe title as a template literal': [
    "const area = 'cart';",
    "test.describe(`area ${area}`, () => {",
    "  test('adds', async () => {});",
    "});"],
  'S3 describe with a details object (tag)': [
    "test.describe('tagged', { tag: '@smoke' }, () => {",
    "  test('inside tagged', async () => {});",
    "});",
    "test('after tagged', async () => {});"],
  'S4 describe with an expression-bodied callback': [
    "test.describe('expr', () => test('inside expr', async () => {}));",
    "test('after expr', async () => {});"],
  'S5 describe.configure before plain cases': [
    "test.describe.configure({ mode: 'serial' });",
    "test('cfg one', async () => {});",
    "test('cfg two', async () => {});"],
};

let fails = 0;
for (const [name, body] of Object.entries(SCENARIOS)) {
  const root = path.join(scratch, `r2-scope-${process.pid}-${name.slice(0, 2)}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.cpSync(nm, path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"r2scope","private":true}');
  fs.writeFileSync(path.join(root, 'playwright.config.ts'), "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n");
  fs.writeFileSync(path.join(root, 'tests', 's.spec.ts'), ["import { test } from '@playwright/test';", ...body, ''].join('\n'));
  const p = { id: 'proj_1_0123456789abcdef01234567', uid: 'proj_1_0123456789abcdef01234567', root };
  const cat = discoverTests(p, withTrust({}, p, { trust: TRUST.TRUSTED }), emptyRegistry());
  const c = cat.consistency ?? {};
  const ok = cat.discovery === 'authoritative' && (c.onlyStatic ?? []).length === 0;
  if (!ok) fails++;
  console.log(`[${name}] ${ok ? 'OK' : 'FAIL'} -- discovery=${cat.discovery} agrees=${c.agrees} onlyStatic=${JSON.stringify(c.onlyStatic)} onlyAuthoritative=${JSON.stringify(c.onlyAuthoritative)}`);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`SUMMARY: ${Object.keys(SCENARIOS).length - fails}/${Object.keys(SCENARIOS).length} OK`);
process.exitCode = fails ? 1 : 0;
