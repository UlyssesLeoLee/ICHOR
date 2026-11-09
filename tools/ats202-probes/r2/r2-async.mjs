// ATS-202 round-2 reviewer probe (Opus): the ASYNC listing path the Bridge really uses.
// Usage: node r2-async.mjs <tree-root> <node_modules-with-@playwright/test-1.64.1> <scratch-dir>   (exit 1 on any FAIL)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [tree, nm, scratch] = process.argv.slice(2).map((p) => path.resolve(p));
const { listTestsAsync, listTests } = await import(pathToFileURL(path.join(tree, 'server/discovery/playwright-list.mjs')).href);
const root = path.join(scratch, `r2-async-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
fs.cpSync(nm, path.join(root, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), '{"name":"r2async","private":true}');
const marker = path.join(root, 'config-finished.txt');
fs.writeFileSync(path.join(root, 'playwright.config.ts'), [
  "import fs from 'node:fs';",
  "import { defineConfig } from '@playwright/test';",
  "const end = Date.now() + 4000; while (Date.now() < end) { /* slow top level */ }",
  `fs.writeFileSync(${JSON.stringify(marker)}, 'finished');`,
  "export default defineConfig({ testDir: './tests' });", ''].join('\n'));
fs.writeFileSync(path.join(root, 'tests', 'a.spec.ts'), "import { test } from '@playwright/test';\ntest('a', async () => {});\n");
const project = { id: 'proj_1_0123456789abcdef01234567', uid: 'proj_1_0123456789abcdef01234567', root };
let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`[${name}] ${ok ? 'OK' : 'FAIL'} -- ${detail}`); };

const t0 = Date.now();
const a = await listTestsAsync(project, { timeoutMs: 1500 });
const took = Date.now() - t0;
await new Promise((r) => setTimeout(r, 5000)); // give a surviving child time to finish its config
check('ASYNC-TIMEOUT-OUTCOME', a.outcome === 'PLAYWRIGHT_LIST_TIMEOUT', `outcome=${a.outcome} reason=${JSON.stringify(a.reason)} took=${took}ms`);
check('ASYNC-TIMEOUT-KILLED', !fs.existsSync(marker), `config-finished marker ${fs.existsSync(marker) ? 'EXISTS: the child kept running after the timeout' : 'absent: the child was killed'}`);
fs.rmSync(marker, { force: true });
const s = listTests(project, { timeoutMs: 1500 });
check('SYNC-TIMEOUT-OUTCOME (reference)', s.outcome === 'PLAYWRIGHT_LIST_TIMEOUT', `outcome=${s.outcome}`);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = fails ? 1 : 0;
