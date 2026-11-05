/**
 * Fixture builder for the ATS-101 probes.
 *
 * The fixture is a REAL Playwright project (@playwright/test installed into its
 * own node_modules) so the probes exercise the genuine Playwright Test CLI,
 * not a double. Two config variants are supported:
 *
 *   withMedia: true   -> use:{screenshot:'only-on-failure',video:'retain-on-failure'}
 *   withMedia: false  -> no screenshot/video in `use`
 *
 * The difference matters for B-01: the screenshot/video artefacts observed in
 * the control experiment come from the FIXTURE's own `use` block, never from
 * the Bridge. A fixture without `use.screenshot`/`use.video` produces no
 * png/webm even when the Bridge run succeeds.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, WORK_ROOT } from './bridge.mjs';

export const PLAYWRIGHT_VERSION = '1.64.1';

const PACKAGE_JSON = (name) => JSON.stringify({
  name,
  version: '1.0.0',
  private: true,
  scripts: { test: 'playwright test' },
  devDependencies: { '@playwright/test': `^${PLAYWRIGHT_VERSION}` },
}, null, 2) + '\n';

const CONFIG_WITH_MEDIA = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { screenshot: 'only-on-failure', video: 'retain-on-failure', trace: 'on' },
});
`;

const CONFIG_WITHOUT_MEDIA = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { trace: 'on' },
});
`;

const FAST_SPEC = `import { test, expect } from '@playwright/test';
test('real browser can launch', async ({ page }) => {
  await page.setContent('<h1 id="t">hello</h1>');
  await expect(page.locator('#t')).toHaveText('hello');
});
test('intentional failure for FAIL path', async ({ page }) => {
  await page.setContent('<h1>actual</h1>');
  await expect(page.locator('#t')).toHaveText('expected-mismatch');
});
`;

const SLOW_SPEC = `import { test, expect } from '@playwright/test';
test('slow case for the stop race', async ({ page }) => {
  await page.setContent('<h1 id="t">slow</h1>');
  await expect(page.locator('#t')).toHaveText('slow');
  await page.waitForTimeout(60000);
});
`;

export function ensureFixture(name, { withMedia = true, slow = false } = {}) {
  const dir = path.join(WORK_ROOT, 'fixtures', name);
  ensureDir(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'package.json'), PACKAGE_JSON(name), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    withMedia ? CONFIG_WITH_MEDIA : CONFIG_WITHOUT_MEDIA,
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'tests', 'probe.spec.ts'),
    slow ? SLOW_SPEC : FAST_SPEC,
    'utf8',
  );
  installPlaywright(dir);
  return dir;
}

/**
 * Run `npm install` inside `dir`.
 *
 * `npm` on PATH may be a POSIX shim that a native Windows child cannot exec,
 * so we prefer running npm's own entry script with the current node binary.
 */
function npmInstall(dir) {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'npm-cli.js',
  ];
  for (const candidate of candidates) {
    const useNode = candidate === 'npm-cli.js'
      ? null
      : fs.existsSync(candidate);
    const cmd = useNode ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const args = useNode
      ? [candidate, 'install', '--no-audit', '--no-fund', '--loglevel=error']
      : ['install', '--no-audit', '--no-fund', '--loglevel=error'];
    const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', shell: false });
    if (r.status === 0) return r;
    lastError = `cmd=${cmd} args=${JSON.stringify(args)}\n${r.stdout || ''}\n${r.stderr || ''}`;
  }
  throw new Error(`npm install failed in ${dir}:\n${lastError}`);
}

let lastError = '';

function installPlaywright(dir) {
  const cli = path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js');
  if (fs.existsSync(cli)) return;
  npmInstall(dir);
  if (!fs.existsSync(cli)) {
    throw new Error(`npm install did not produce ${cli} in ${dir}`);
  }
}

/** The exact fixture `playwright.config.ts` text, for inclusion in the evidence log. */
export function configText(withMedia) {
  return withMedia ? CONFIG_WITH_MEDIA : CONFIG_WITHOUT_MEDIA;
}
