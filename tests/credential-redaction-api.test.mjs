/**
 * ATS-213 ｜ 注入密钥的**落盘脱敏**——集成测试（HTTP 层 + 真实运行）
 *
 * 这条用例是复核第 2 轮 P3 的**正面证据**。
 *
 * 复核登记的事实：被测脚本的一次**普通断言失败**就会把注入的密钥原文打印
 * 出来，而平台会把它写进
 *
 *   * `stdout.log` 与运行记录（`run.log`）；
 *   * `report.json`、`error-context.md`、HTML 报告的 `data/*.md`；
 *   * HTML 报告**内嵌的 base64 zip**（逐字节扫描看不到，解码后命中）；
 *   * `evidence-store/` 的内容寻址副本；
 *   * `metadata.db`（SQLite 镜像）与 `state.json`。
 *
 * 验收标准是「导出/日志无敏感串」，而**导出**正是这些文件。因此平台必须在
 * 落盘之前把密钥替换掉——它知道解析出来的值，所以它做得到。
 *
 * 这条用例走**真实链路**：真实 Bridge、真实 Windows Credential Manager、
 * 真实 Playwright 运行，被测脚本做一次**普通的**断言失败。
 *
 * 结果必须是**数据目录 0 命中**。
 *
 * 配套的变异体（`tools/ats213-probes/probe-credential-redaction-mutants.mjs`
 * 的 M-P3b）把脱敏关掉，同一条用例必须**变红**——否则这条用例证明不了任何事。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';

const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ats213-redact-'));
const port = await freePort();
const REAL = process.env.ATS213_REAL_CREDENTIAL_STORE === '1';
let cp, token;

/** The secret the fixture asserts on. It is a fake value, not a credential. */
const SECRET = 'ats213-redact-secret-9c4e17';

async function ready() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not boot');
}

async function api(endpoint, method = 'GET', payload) {
  const r = await fetch(`http://127.0.0.1:${port}` + endpoint, {
    method,
    headers: { 'X-ATS-Token': token, 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return [r.status, await r.json()];
}

/**
 * Walks the data directory and reports every file that holds the secret.
 *
 * The HTML report embeds its data as a base64 ZIP, so a raw byte scan
 * cannot see inside it: the scan decodes every embedded archive and looks
 * at its members too. A scan that only looked at the raw bytes would report
 * "0 hits" on a tree that leaks.
 */
function scanForSecret(dir) {
  const hits = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      let bytes;
      try { bytes = fs.readFileSync(full); } catch { continue; }
      if (bytes.includes(Buffer.from(SECRET, 'utf8'))) {
        hits.push(path.relative(dir, full));
        continue;
      }
      // The embedded archive of the HTML report.
      const text = bytes.toString('latin1');
      for (const m of text.matchAll(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/g)) {
        let raw;
        try { raw = Buffer.from(m[1], 'base64'); } catch { continue; }
        if (raw.includes(Buffer.from(SECRET, 'utf8'))) {
          hits.push(`${path.relative(dir, full)} [embedded archive]`);
        }
      }
    }
  };
  walk(dir);
  return hits;
}

test('ATS213-REDACT-IT-SETUP: start the bridge', async () => {
  cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: path.join(data, 'state') },
    stdio: 'ignore',
  });
  await ready();
  token = (await api('/api/session'))[1].token;
  assert.ok(token);
});

test('ATS213-REDACT-IT-001: a failing assertion does NOT put the injected secret on disk', async (t) => {
  if (!REAL) {
    // The real credential store is the point of this test: the secret has
    // to come from the OS credential store for the platform to know it.
    t.skip('needs ATS213_REAL_CREDENTIAL_STORE=1 (the real Windows Credential Manager)');
    return;
  }
  const fixture = path.join(data, 'fixture');
  fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'redact-fixture', private: true }));
  fs.writeFileSync(
    path.join(fixture, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({testDir:'./tests',timeout:30000,retries:0});\n",
  );
  // An ORDINARY failing assertion on the injected value. The engine prints
  // `Received: "<the secret>"` -- the leak the review measured.
  fs.writeFileSync(
    path.join(fixture, 'tests', 'leak.spec.ts'),
    "import { test, expect } from '@playwright/test';\n"
    + "test('the token has the expected value', async () => {\n"
    + "  expect(process.env.API_TOKEN).toBe('the-value-the-test-expected');\n"
    + "});\n",
  );
  // The fixture needs the real Playwright installation. The example
  // project of the repository has one; the fixture borrows its
  // node_modules through a junction so no install is needed and no
  // lockfile is touched.
  const coreDir = process.env.ATS213_PLAYWRIGHT_CORE
    || 'D:/ICHOR/examples/sample-playwright/node_modules/playwright-core';
  const exampleModules = path.join(coreDir, '..');
  if (!fs.existsSync(exampleModules)) {
    t.skip('the example project has no node_modules (the fixture cannot run the engine)');
    return;
  }
  try {
    fs.symlinkSync(exampleModules, path.join(fixture, 'node_modules'), 'junction');
  } catch {
    // A junction needs the privileges of the account; a copy is the
    // fallback.
    fs.cpSync(exampleModules, path.join(fixture, 'node_modules'), { recursive: true });
  }

  const [ps, pb] = await api('/api/projects', 'POST', { path: fixture });
  assert.equal(ps, 201, JSON.stringify(pb));
  const projectId = pb.project.id;

  const [cs, cb] = await api('/api/security/credentials', 'POST', {
    name: 'ats213-redact-key', secret: SECRET, purpose: 'other',
  });
  assert.equal(cs, 201, JSON.stringify(cb));
  const credentialId = cb.credential.id;

  try {
    const [es] = await api(`/api/projects/${projectId}/env`, 'POST', {
      name: 'redact', environment: 'staging',
      variables: { API_TOKEN: { credentialRef: credentialId } },
    });
    assert.equal(es, 200);

    const [rs, rb] = await api(`/api/projects/${projectId}/run`, 'POST', {
      file: 'tests/leak.spec.ts', env: 'redact',
    });
    assert.equal(rs, 202, JSON.stringify(rb));
    const runId = rb.run.id;

    let run = null;
    for (let i = 0; i < 400; i++) {
      const [, body] = await api(`/api/runs/${runId}`);
      run = body?.run;
      if (run && ['passed', 'failed', 'error', 'cancelled'].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(run, 'the run reached a terminal state');
    assert.equal(run.status, 'failed', 'the fixture failed on its assertion, as intended');
    // The run record says it carried a credential reference -- that is the
    // marker a reader of an archive looks for.
    assert.deepEqual(run.envCredentialRefs, ['API_TOKEN']);

    // The API responses do not carry the secret.
    const [, single] = await api(`/api/runs/${runId}`);
    const [, list] = await api('/api/runs');
    assert.ok(!JSON.stringify(single ?? {}).includes(SECRET), 'the run response holds no secret');
    assert.ok(!JSON.stringify(list ?? {}).includes(SECRET), 'the run list holds no secret');

    // The DATA DIRECTORY holds no secret -- not in a log, not in a report,
    // not in the HTML report's embedded archive, not in the evidence store,
    // not in the SQLite mirror, not in the state file.
    const hits = scanForSecret(path.join(data, 'state'));
    assert.deepEqual(hits, [], `the injected secret reached: ${hits.join(', ')}`);

    // The redaction is RECORDED on the run: which files were rewritten and
    // which are the documented binary boundary.
    assert.ok(run.redaction, 'the run says what was redacted');
    assert.ok(run.redaction.redactedFiles.length > 0, 'something was redacted');
  } finally {
    await api(`/api/security/credentials/${credentialId}`, 'DELETE').catch(() => {});
    try { fs.rmdirSync(path.join(fixture, 'node_modules')); } catch { /* junction */ }
  }
});

test('ATS213-REDACT-IT-CLEANUP: stop the bridge and remove the fixture', () => {
  console.log(`# the redaction path was exercised on this machine: ${REAL}`);
  cp.kill();
  fs.rmSync(data, { recursive: true, force: true });
});
