import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/**
 * Reproduces the intermittent IT failure: two test files that draw their port
 * from overlapping random ranges can pick the SAME port, and the second
 * bridge fails to bind. The failing test then reports "server did not boot".
 *
 * The four IT files pick their port from:
 *   api.test.mjs        19000-28999
 *   runner.test.mjs     21000-30999
 *   uid-api.test.mjs    23000-32999
 *   agent-api.test.mjs  25000-32999
 *
 * This script forces the collision (both files onto the same port) and shows
 * the failure the suite shows, so the mechanism is documented rather than
 * guessed.
 */
const root = path.resolve(import.meta.dirname, '..', '..');

const startBridge = (port, data) => new Promise((resolve) => {
  const cp = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, ATS_PORT: String(port), ATS_DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  cp.stderr.on('data', (b) => { err += b.toString(); });
  cp.stdout.on('data', (b) => { err += b.toString(); });
  setTimeout(() => resolve({ cp, err }), 1500);
});

const dataA = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-port-a-'));
const dataB = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-port-b-'));
const port = 35777;

console.log(`--- two bridges on the same port ${port} ---`);
const a = await startBridge(port, dataA);
const b = await startBridge(port, dataB);
console.log(`first  bridge: ${a.err.trim().split('\n').pop() || '(no output)'}`);
console.log(`second bridge: ${b.err.trim().split('\n').pop() || '(no output)'}`);

const firstUp = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false);
console.log(`the port serves the first bridge: ${firstUp}`);
console.log(`the second bridge could not bind: ${/EADDRINUSE/.test(b.err)}`);

a.cp.kill();
b.cp.kill();
fs.rmSync(dataA, { recursive: true, force: true });
fs.rmSync(dataB, { recursive: true, force: true });

const ok = /EADDRINUSE/.test(b.err);
console.log('');
console.log(ok ? 'RESULT: REPRODUCED (the overlap of the port ranges is a real failure mode)' : 'RESULT: NOT REPRODUCED');
process.exit(ok ? 0 : 1);
