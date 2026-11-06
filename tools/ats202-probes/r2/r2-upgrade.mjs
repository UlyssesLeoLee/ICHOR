// ATS-202 round-2 reviewer probe (Opus): the scanner fix (CE-C/D/I) changes the STATIC reading of a title.
// Does an existing STATIC UID survive the upgrade from the round-1 tree to the round-2 tree (same registry)?
// Usage: node r2-upgrade.mjs <old-tree> <new-tree> <scratch-dir>   (exit 1 on any FAIL)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [oldTree, newTree, scratch] = process.argv.slice(2).map((p) => path.resolve(p));
const load = async (t) => ({
  core: await import(pathToFileURL(path.join(t, 'server/core.mjs')).href),
  uid: await import(pathToFileURL(path.join(t, 'server/uid.mjs')).href),
});
const OLD = await load(oldTree), NEW = await load(newTree);
const CASES = {
  'escaped quote': "test('user\\'s profile', async () => { expect(1).toBe(1); });",
  'title > 180 chars': `test('${'checkout ' + 'x'.repeat(190)}', async () => { expect(3).toBe(3); });`,
  'multi-line call': "test(\n  'multi line',\n  async () => { expect(7).toBe(7); }\n);",
};
let fails = 0;
for (const [name, line] of Object.entries(CASES)) {
  const root = path.join(scratch, `r2-upgrade-${process.pid}-${name.replace(/\W+/g, '-')}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'u.spec.ts'), ["import { test, expect } from '@playwright/test';", line, "test('neighbour', async () => { expect(9).toBe(9); });", ''].join('\n'));
  const p = { id: 'proj_1_0123456789abcdef01234567', uid: 'proj_1_0123456789abcdef01234567', root };
  const before = OLD.core.discoverTests(p, {}, OLD.uid.emptyRegistry());
  const after = NEW.core.discoverTests(p, {}, before.registry);
  const b = before.tests.find((t) => t.title !== 'neighbour'), a = after.tests.find((t) => t.title !== 'neighbour');
  const ok = b && a && b.uid === a.uid;
  if (!ok) fails++;
  console.log(`[${name}] ${ok ? 'OK' : 'FAIL'} -- static UID on the round-1 tree ${b?.uid} (title ${JSON.stringify(b?.title?.slice(0, 30))}) -> after upgrade ${a?.uid} (${a?.uidSource}, title ${JSON.stringify(a?.title?.slice(0, 30))})`);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`SUMMARY: ${Object.keys(CASES).length - fails}/${Object.keys(CASES).length} existing static UIDs survive the upgrade`);
process.exitCode = fails ? 1 : 0;
