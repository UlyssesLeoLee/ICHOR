#!/usr/bin/env node
/**
 * ATS-506 negative controls: the control-plane guards are not vacuous.
 *
 * The unit suite (tests/control-plane.test.mjs) resolves every path from its
 * own location, so it can run against a COPY of the relevant tree. This probe
 * copies the control plane, the suite, docs/19, the Tauri lib.rs and the
 * studio sources into a temporary root, then:
 *
 *   0. runs the suite on the unmodified copy        -> must PASS;
 *   1..N applies one mutation that breaks one guard -> the suite must FAIL,
 *      and the failing test must be the one that owns the guard.
 *
 * A mutation whose needle is not found counts as a probe failure: a probe
 * that silently mutates nothing would prove nothing. The repository itself is
 * never modified.
 *
 * Usage: node tools/ats506-probes/mutation-tests.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COPY = [
  'server/control-plane', 'tests/control-plane.test.mjs', 'docs/19-REMOTE-RUNNER-PROTOCOL.md',
  'src-tauri/src/lib.rs', 'apps/studio/app', 'apps/studio/lib',
];

const MUTATIONS = [
  {
    id: 'M1', guard: 'UT-CP-028 import allow-list',
    file: 'server/control-plane/app.mjs',
    needle: "import crypto from 'node:crypto';",
    replace: "import crypto from 'node:crypto';\nimport { spawn } from 'node:child_process';",
    expect: 'UT-CP-028',
  },
  {
    id: 'M2', guard: 'UT-CP-001 Windows drive-path rule',
    file: 'server/control-plane/boundary.mjs',
    needle: "  ['windows_drive_path', /^[A-Za-z]:(?:[\\\\/]|$)/],\n  ['windows_drive_path', /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\\\/]/],\n",
    replace: '',
    expect: 'UT-CP-001',
  },
  {
    id: 'M3', guard: 'UT-CP-016 local credential refusal',
    file: 'server/control-plane/app.mjs',
    needle: "if (req.headers[header] !== undefined) reject('REMOTE_UNAUTHENTICATED', 'local_credential_presented');",
    replace: '/* local credential accepted */',
    expect: 'UT-CP-016',
  },
  {
    id: 'M4', guard: 'UT-CP-026 egress guard',
    file: 'server/control-plane/app.mjs',
    needle: 'const leak = inspectValue(body, { fieldNames: false });',
    replace: 'const leak = null;',
    expect: 'UT-CP-026',
  },
  {
    id: 'M5', guard: 'UT-CP-008 code table vs docs/19',
    file: 'server/control-plane/errors.mjs',
    needle: "REMOTE_PATH_FORBIDDEN: { http: 422,",
    replace: "REMOTE_PATH_FORBIDDEN: { http: 400,",
    expect: 'UT-CP-008',
  },
  {
    id: 'M6', guard: 'UT-CP-029 Tauri command list',
    file: 'src-tauri/src/lib.rs',
    needle: 'generate_handler![local_bridge_status]',
    replace: 'generate_handler![local_bridge_status, control_plane_proxy]',
    expect: 'UT-CP-029',
  },
  {
    id: 'M7', guard: 'UT-CP-024 cross-tenant isolation',
    file: 'server/control-plane/app.mjs',
    needle: 'PROJECT_UID.test(r.uid) ? tenantProjects(tenantId).get(r.uid) : undefined',
    replace: 'PROJECT_UID.test(r.uid) ? [...store.values()].map((m) => m.get(r.uid)).find(Boolean) : undefined',
    expect: 'UT-CP-024',
  },
  {
    id: 'M8', guard: 'UT-CP-019 raw dot-segment refusal',
    file: 'server/control-plane/app.mjs',
    needle: "if (segment === '.' || segment === '..') reject('REMOTE_PATH_FORBIDDEN', 'path_traversal');",
    replace: "if (segment === '.' || segment === '..') continue;",
    expect: 'UT-CP-019',
  },
];

function copyTree(dest) {
  for (const rel of COPY) {
    const from = path.join(REPO, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
}

function runSuite(rootDir) {
  // A per-test timeout and a process timeout: a mutation must make the suite
  // FAIL, never hang the probe.
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=60000', '--test-reporter=spec', path.join(rootDir, 'tests/control-plane.test.mjs')],
    { encoding: 'utf8', cwd: rootDir, timeout: 240000 });
  const failed = [...String(r.stdout || '').matchAll(/^\s*✖ (UT-CP-\d+)/gm)].map((m) => m[1]);
  return { status: r.status === null ? `killed(${r.signal})` : r.status, failed: [...new Set(failed)] };
}

console.log('=== ATS-506 negative controls: control-plane guard mutations ===');
console.log(`repo root : ${REPO}`);
console.log('');

let bad = 0;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ats506-mut-'));
try {
  const clean = path.join(base, 'clean');
  copyTree(clean);
  const c = runSuite(clean);
  const cleanOk = c.status === 0 && c.failed.length === 0;
  console.log(`  ${cleanOk ? 'PASS' : 'FAIL'}  M0 unmodified copy: suite exit=${c.status}, failing=[${c.failed.join(', ')}]`);
  if (!cleanOk) bad++;

  for (const m of MUTATIONS) {
    const dir = path.join(base, m.id);
    copyTree(dir);
    const target = path.join(dir, m.file);
    const text = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    if (!text.includes(m.needle)) {
      console.log(`  FAIL  ${m.id} ${m.guard}: needle not found in ${m.file} -- the mutation was not applied`);
      bad++;
      continue;
    }
    fs.writeFileSync(target, text.replace(m.needle, m.replace));
    const r = runSuite(dir);
    const caught = r.status !== 0 && r.failed.includes(m.expect);
    console.log(`  ${caught ? 'PASS' : 'FAIL'}  ${m.id} ${m.guard}: suite exit=${r.status}, failing=[${r.failed.join(', ')}] (expected ${m.expect})`);
    if (!caught) bad++;
  }
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('');
console.log(bad === 0
  ? `RESULT: OK -- the unmodified copy passes and all ${MUTATIONS.length} mutations are caught by the guard that owns them.`
  : `RESULT: FAIL -- ${bad} control(s) did not behave as required.`);
process.exit(bad === 0 ? 0 : 1);
