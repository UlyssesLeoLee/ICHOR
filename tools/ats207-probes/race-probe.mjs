/**
 * ATS-207 probe: N processes acquire one lock file at the same instant.
 *
 *   node tools/ats207-probes/race-probe.mjs <core-module> <scratch-dir> [n] [stale]
 *
 * <core-module> is the module that exports acquireBridgeLock (the current
 * server/core.mjs, or a copy of an older revision placed next to it).
 * With `stale`, a lock of a dead pid exists before the race.
 * Prints one verdict per child and `RESULT: winners=<k>`; exits 0 only when
 * exactly one child won.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [moduleArg, scratch, nArg, staleArg] = process.argv.slice(2);
if (!moduleArg || !scratch) { console.error('usage: race-probe.mjs <core-module> <scratch-dir> [n] [stale]'); process.exit(2); }
const n = Number(nArg || 6);
const url = pathToFileURL(path.resolve(moduleArg)).href;
fs.mkdirSync(scratch, { recursive: true });
const dir = fs.mkdtempSync(path.join(scratch, 'race-'));
const file = path.join(dir, 'bridge.lock');
const go = path.join(dir, 'GO');
const done = path.join(dir, 'DONE');
if (staleArg === 'stale') fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, startedAt: '2026-01-01T00:00:00Z' }));
const code = `import * as core from ${JSON.stringify(url)};import fs from 'node:fs';` +
  `if(core.ownProcessStartTime)core.ownProcessStartTime();console.log('READY');` +
  `const w=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(${JSON.stringify(go)}))Atomics.wait(w,0,0,1);` +
  `try{core.acquireBridgeLock(${JSON.stringify(file)});console.log('WON');}catch(e){console.log(e.code==='BRIDGE_ALREADY_RUNNING'?'HELD':'ERR '+e.message);}` +
  `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(done)})){clearInterval(t);process.exit(0);}},20);`;
const kids = Array.from({ length: n }, () => spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] }));
const line = (k, re) => new Promise((resolve) => { let o = ''; k.stdout.on('data', (b) => { o += b; if (re.test(o)) resolve(o.trim().split('\n').pop()); }); k.on('close', () => resolve(o.trim().split('\n').pop() || 'EXITED')); });
await Promise.all(kids.map((k) => line(k, /READY/)));
const verdicts = kids.map((k) => line(k, /WON|HELD|ERR/));
fs.writeFileSync(go, '');
const out = await Promise.all(verdicts);
fs.writeFileSync(done, '');
out.forEach((v, i) => console.log(`child ${i + 1} pid ${kids[i].pid}: ${v}`));
const winners = out.filter((v) => v === 'WON').length;
let holder = null;
try { holder = JSON.parse(fs.readFileSync(file, 'utf8')).pid; } catch { /* none */ }
console.log(`lock file names pid ${holder}`);
console.log(`RESULT: winners=${winners} (expected 1)`);
setTimeout(() => { kids.forEach((k) => { try { k.kill(); } catch { /* gone */ } }); fs.rmSync(dir, { recursive: true, force: true }); process.exit(winners === 1 ? 0 : 1); }, 300);
