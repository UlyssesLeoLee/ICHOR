import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';
const root=path.resolve(import.meta.dirname,'..');
const base=path.resolve(root,'examples/sample-playwright');
// Whether the repository example has a local Playwright CLI. The capability
// negotiation over the four REQUIRED capabilities can only be asserted when
// the engine is actually installed, so the test that needs it skips itself
// (the same convention the IT-ADP series uses) instead of failing.
const pwInstalled=fs.existsSync(path.join(base,'node_modules','@playwright','test','cli.js'));
const data=fs.mkdtempSync(path.join(os.tmpdir(),'ats-api-'));const port=await freePort();
// A project that satisfies the Bridge's validation but has NO local Playwright
// install. IT-RUN-001 needs "the engine is missing => explicit failure", so it
// owns this fixture instead of depending on whether the repository example
// happens to have node_modules installed on this machine.
const noDeps=fs.mkdtempSync(path.join(os.tmpdir(),'ats-nodeps-'));
fs.writeFileSync(path.join(noDeps,'package.json'),'{}');
fs.writeFileSync(path.join(noDeps,'playwright.config.ts'),'export default {}');
let cp,token,projectId,noDepsId;
// The ready() window below is 400 attempts, not the 70-100 it used to be.
// `npm test` runs the test files in PARALLEL, and 14 of them each boot a
// Bridge. Booting 14 servers at once is slow: measured on this machine the
// boot takes 1289 / 5637 / 8582 ms (min / median / max), while the old
// windows only allowed 4000 ms (80 x 50ms) or 2450 ms (70 x 35ms). So the
// slow ones gave up with "server did not boot" -- non-deterministically, on a
// DIFFERENT subset each run.
//
// It was never a port collision: 14 concurrent servers were measured and
// their ports were all distinct. 400 attempts x 50ms = 20s and x 35ms = 14s,
// which covers the measured worst case with room to spare, and a test that
// genuinely cannot start still fails instead of hanging forever.
// The health probe is BOUNDED. An unbounded fetch turns ONE request that
// never comes back into a stall of the whole boot window, and the boot wait
// then reports "the bridge did not come up" for a bridge that IS listening
// and merely busy. Measured: a hung probe made the wait 31 s long (the 20 s
// window plus an ~11 s request that never came back). The timeout is far
// below the window, so a slow-but-alive bridge is still found, and a hung
// request is retried instead of consuming the wait.
async function ready(){for(let i=0;i<400;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('server did not boot');}
async function api(endpoint,method='GET',payload,auth=true){const r=await fetch(`http://127.0.0.1:${port}`+endpoint,{method,headers:auth?{'X-ATS-Token':token,'Content-Type':'application/json'}:{},body:payload?JSON.stringify(payload):undefined});return [r.status,await r.json()];}
test('IT-API-SETUP: start server',async()=>{cp=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,ATS_PORT:String(port),ATS_DATA_DIR:data},stdio:'ignore'});await ready();const r=await api('/api/session');token=r[1].token;assert.ok(token);});
test('IT-SEC-001: rejects unauthenticated API',async()=>{const r=await api('/api/projects','GET',undefined,false);assert.equal(r[0],401);});
test('IT-API-001: add existing repository',async()=>{const r=await api('/api/projects','POST',{path:base});assert.equal(r[0],201);projectId=r[1].project.id;});
test('IT-API-002: import and index tests',async()=>{const r=await api(`/api/projects/${projectId}/tests`);assert.equal(r[0],200);assert.equal(r[1].tests.length,2);});
test('IT-SEC-002: rejects foreign origin',async()=>{const r=await fetch(`http://127.0.0.1:${port}/api/session`,{headers:{Origin:'https://evil.example'}});assert.equal(r.status,403);});
// A WHITELISTED origin gets its own origin name back. The browser blocks
// every cross-origin response that lacks `Access-Control-Allow-Origin`, so
// a whitelisted client (the Next dev server on 3000, the Tauri shell) could
// not read a single API answer without this header -- even though the
// origin passed the whitelist check.
test('IT-SEC-002B: a whitelisted origin is echoed back in the CORS header',async()=>{
 const origin=`http://127.0.0.1:3000`;
 const r=await fetch(`http://127.0.0.1:${port}/api/session`,{headers:{Origin:origin}});
 assert.equal(r.status,200);
 assert.equal(r.headers.get('access-control-allow-origin'),origin,`the CORS header is ${JSON.stringify(r.headers.get('access-control-allow-origin'))}, expected ${origin}`);
 // The pre-flight has to name the origin too, and it has to allow the
 // methods the environment routes use (DELETE included).
 const pre=await fetch(`http://127.0.0.1:${port}/api/projects/x/env`,{method:'OPTIONS',headers:{Origin:origin}});
 assert.equal(pre.status,204);
 assert.equal(pre.headers.get('access-control-allow-origin'),origin);
 assert.match(pre.headers.get('access-control-allow-methods')||'',/\bDELETE\b/);
});
test('IT-API-001B: add a project without the engine installed',async()=>{const r=await api('/api/projects','POST',{path:noDeps});assert.equal(r[0],201);noDepsId=r[1].project.id;});
test('IT-RUN-001: no deps => explicit failure rather than fake success',async()=>{const r=await api(`/api/projects/${noDepsId}/run`,'POST',{});assert.equal(r[0],202);assert.equal(r[1].run.status,'error');});
test('IT-API-003: runs survive persisted read',async()=>{const r=await api('/api/runs');assert.equal(r[1].runs.length,1);assert.equal(r[1].runs[0].status,'error');});
// --- ATS-301: capability negotiation over HTTP ---------------------------
test('IT-API-010: GET /runners returns the capability matrix',async()=>{
 const r=await api(`/api/projects/${projectId}/runners`);
 assert.equal(r[0],200);
 assert.ok(Array.isArray(r[1].runners));
 assert.ok(r[1].runners.length>=2);
 assert.ok(Array.isArray(r[1].capabilities));
 const kinds=r[1].capabilities.map(c=>c.kind);
 assert.ok(kinds.includes('playwright'),JSON.stringify(kinds));
 // Every capability entry carries the fields a client has to be able to read.
 for(const c of r[1].capabilities){
  assert.equal(typeof c.kind,'string');
  assert.ok(Array.isArray(c.capabilities));
  for(const cap of c.capabilities){
   assert.equal(typeof cap.name,'string');
   assert.equal(typeof cap.supported,'boolean');
   // An unsupported capability MUST carry a reason; a supported one must
   // carry evidence. This is the contract rule 1/2, checked over the wire.
   if(cap.supported)assert.ok(cap.evidence,`${cap.name} has no evidence`);
   else assert.ok(cap.reason,`${cap.name} has no reason`);
  }
 }
});
test('IT-API-011: POST /runners with an unsatisfiable capability is 409 WITH the reason',async()=>{
 const r=await api(`/api/projects/${projectId}/runners`,'POST',{capabilities:['filterByTestUid']});
 assert.equal(r[0],409);
 assert.equal(r[1].error,'NO_RUNNER_SUPPORTS_REQUEST');
 // The reason must survive: which capability, and why.
 assert.ok(Array.isArray(r[1].missing),JSON.stringify(r[1]));
 const m=r[1].missing.find(x=>x.name==='filterByTestUid');
 assert.ok(m,JSON.stringify(r[1].missing));
 assert.equal(typeof m.reason,'string');
 assert.ok(m.reason.length>0);
 // The per-runner view is available too.
 assert.ok(Array.isArray(r[1].rejected));
 assert.ok(r[1].rejected.length>=1);
});
test('IT-API-012: POST /runners with a PINNED runner that cannot satisfy the request is 409 WITH the reason',async()=>{
 const r=await api(`/api/projects/${projectId}/runners`,'POST',{runner:'wdio',capabilities:['filterByTestUid']});
 assert.equal(r[0],409);
 assert.ok(Array.isArray(r[1].missing),JSON.stringify(r[1]));
 const m=r[1].missing.find(x=>x.name==='filterByTestUid');
 assert.ok(m,JSON.stringify(r[1].missing));
 assert.ok(m.reason.length>0);
});
// The negotiation SHAPE is a property of the API, not of the engine that
// happens to be installed under examples/sample-playwright. An EMPTY
// capability list asks nothing of any runner, so it is satisfiable whether
// or not the fixture has a local Playwright CLI -- which is what makes this
// test run on a clean checkout (no node_modules) instead of failing there.
//
// The four REQUIRED capabilities are still asserted, but on the real fixture,
// in IT-API-013B, which skips itself when the engine is not installed (the
// same convention the IT-ADP series uses).
test('IT-API-013: the pinned and unpinned success responses have the SAME negotiation shape',async()=>{
 const unpinned=await api(`/api/projects/${projectId}/runners`,'POST',{capabilities:[]});
 assert.equal(unpinned[0],200);
 const pinned=await api(`/api/projects/${projectId}/runners`,'POST',{runner:'playwright',capabilities:[]});
 assert.equal(pinned[0],200);
 // Both carry a negotiation RESULT under the same key, with the same fields.
 for(const r of [unpinned,pinned]){
  assert.ok(r[1].negotiation,JSON.stringify(r[1]));
  assert.equal(typeof r[1].negotiation.supported,'boolean');
  assert.ok(Array.isArray(r[1].negotiation.requested));
  assert.ok(Array.isArray(r[1].negotiation.missing));
  assert.ok(Array.isArray(r[1].negotiation.capabilities));
  assert.equal(typeof r[1].negotiation.adapter,'string');
 }
 // An empty request is satisfiable by every runner, so the negotiation
 // reports success and no capability is missing.
 assert.equal(unpinned[1].negotiation.supported,true);
 assert.deepEqual(unpinned[1].negotiation.missing,[]);
 assert.equal(pinned[1].negotiation.supported,true);
 assert.deepEqual(pinned[1].negotiation.missing,[]);
});
test('IT-API-013B: the four REQUIRED capabilities are supported on the real fixture',{skip:!pwInstalled&&'examples/sample-playwright has no node_modules'},async()=>{
 const unpinned=await api(`/api/projects/${projectId}/runners`,'POST',{capabilities:['discover','start','stop','collect']});
 assert.equal(unpinned[0],200);
 const pinned=await api(`/api/projects/${projectId}/runners`,'POST',{runner:'playwright',capabilities:['discover','start','stop','collect']});
 assert.equal(pinned[0],200);
 for(const r of [unpinned,pinned]){
  assert.ok(r[1].negotiation,JSON.stringify(r[1]));
  assert.equal(typeof r[1].negotiation.supported,'boolean');
  assert.ok(Array.isArray(r[1].negotiation.requested));
  assert.ok(Array.isArray(r[1].negotiation.missing));
  assert.ok(Array.isArray(r[1].negotiation.capabilities));
  assert.equal(typeof r[1].negotiation.adapter,'string');
  // The four required capabilities are the ones the contract declares as
  // 'required', so they are the ones a real engine has to provide.
  assert.equal(r[1].negotiation.supported,true,JSON.stringify(r[1].negotiation.missing));
 }
});
test('IT-API-014: POST /run with an unsatisfiable capability is 409 WITH the reason',async()=>{
 const r=await api(`/api/projects/${projectId}/run`,'POST',{capabilities:['filterByTestUid']});
 assert.equal(r[0],409);
 assert.ok(Array.isArray(r[1].missing),JSON.stringify(r[1]));
 const m=r[1].missing.find(x=>x.name==='filterByTestUid');
 assert.ok(m,JSON.stringify(r[1].missing));
 assert.ok(m.reason.length>0);
});
test('IT-API-015: a non-array capabilities is a 400, not a silent empty request',async()=>{
 const r=await api(`/api/projects/${projectId}/runners`,'POST',{capabilities:'filterByFile'});
 assert.equal(r[0],400);
 assert.equal(r[1].error,'CAPABILITIES_NOT_AN_ARRAY');
});
// --- ATS-201: the duplicate check uses the UID normalisation ---------------
// `realpathSync` keeps the case of the path it was given, so on a case
// insensitive filesystem `D:\Proj` and `D:\proj` are the same directory but
// two different strings. The duplicate check has to use the SAME
// normalisation as the UID, otherwise the same repository is registered
// twice under ONE identifier: two records, one id.
test('IT-API-016: the same project under a different spelling is refused',async()=>{
 // Its own fixture: the repository example is already registered above.
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'ats-case-proj-'));
 fs.writeFileSync(path.join(fixture,'package.json'),'{}');
 fs.writeFileSync(path.join(fixture,'playwright.config.ts'),'export default {}');
 const first=await api('/api/projects','POST',{path:fixture});
 assert.equal(first[0],201);
 const id=first[1].project.id;
 const second=await api('/api/projects','POST',{path:fixture.toUpperCase()});
 assert.equal(second[0],409);
 assert.equal(second[1].error,'PROJECT_ALREADY_REGISTERED');
 const list=await api('/api/projects');
 const ids=list[1].projects.map(p=>p.id);
 assert.equal(new Set(ids).size,ids.length,'every registered project has its own identifier');
 assert.ok(ids.includes(id));
 fs.rmSync(fixture,{recursive:true,force:true});
});
test('IT-API-CLEANUP: stop and cleanup',()=>{cp.kill();fs.rmSync(data,{recursive:true,force:true});fs.rmSync(noDeps,{recursive:true,force:true});});
