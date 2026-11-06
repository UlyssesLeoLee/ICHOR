// ATS-202 round-3 reviewer probe (Opus): the trust gate on the ASYNC path (the one the Bridge uses), with a real CLI and a top-level marker.
// Usage: node r3-gate-async.mjs <tree-root> <node_modules-with-@playwright/test-1.64.1> <scratch-dir>   (exit 1 on FAIL)
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const [tree, nm, scratch] = process.argv.slice(2).map((p) => path.resolve(p));
const { discoverTestsAsync } = await import(pathToFileURL(path.join(tree, 'server/core.mjs')).href);
const { withTrust, TRUST } = await import(pathToFileURL(path.join(tree, 'server/discovery/trust.mjs')).href);
const { emptyRegistry } = await import(pathToFileURL(path.join(tree, 'server/uid.mjs')).href);
const root = path.join(scratch, `r3-gate-${process.pid}`); fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'tests'), { recursive: true }); fs.cpSync(nm, path.join(root, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), '{"name":"r3gate","private":true}');
fs.writeFileSync(path.join(root, 'playwright.config.ts'), "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n");
const marker = path.join(root, 'spec-top-level-ran.txt');
fs.writeFileSync(path.join(root, 'tests', 'm.spec.ts'), `import fs from 'node:fs';\nimport { test } from '@playwright/test';\nfs.writeFileSync(${JSON.stringify(marker)}, 'ran');\ntest('m', async () => {});\n`);
const p = { id: 'proj_1_0123456789abcdef01234567', uid: 'proj_1_0123456789abcdef01234567', root };
let fails = 0; const check = (n, ok, d) => { if (!ok) fails++; console.log(`[${n}] ${ok ? 'OK' : 'FAIL'} -- ${d}`); };
for (const forced of [undefined, true]) {
  const c = await discoverTestsAsync(p, {}, emptyRegistry(), forced === undefined ? {} : { authoritative: true });
  check(`UNTRUSTED${forced ? '+authoritative=true' : ''}`, c.discovery === 'static' && !fs.existsSync(marker), `discovery=${c.discovery} outcome=${c.authoritative.outcome} marker=${fs.existsSync(marker)}`);
}
const t = await discoverTestsAsync(p, withTrust({}, p, { trust: TRUST.TRUSTED }), emptyRegistry());
check('TRUSTED (control)', t.discovery === 'authoritative' && fs.existsSync(marker), `discovery=${t.discovery} marker=${fs.existsSync(marker)}`);
fs.rmSync(root, { recursive: true, force: true }); process.exitCode = fails ? 1 : 0;
