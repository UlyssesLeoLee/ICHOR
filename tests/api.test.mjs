import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const base=path.resolve(root,'examples/sample-playwright');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'ats-api-'));const port=19000+Math.floor(Math.random()*10000);
// A project that satisfies the Bridge's validation but has NO local Playwright
// install. IT-RUN-001 needs "the engine is missing => explicit failure", so it
// owns this fixture instead of depending on whether the repository example
// happens to have node_modules installed on this machine.
const noDeps=fs.mkdtempSync(path.join(os.tmpdir(),'ats-nodeps-'));
fs.writeFileSync(path.join(noDeps,'package.json'),'{}');
fs.writeFileSync(path.join(noDeps,'playwright.config.ts'),'export default {}');
let cp,token,projectId,noDepsId;
async function ready(){for(let i=0;i<80;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('server did not boot');}
async function api(endpoint,method='GET',payload,auth=true){const r=await fetch(`http://127.0.0.1:${port}`+endpoint,{method,headers:auth?{'X-ATS-Token':token,'Content-Type':'application/json'}:{},body:payload?JSON.stringify(payload):undefined});return [r.status,await r.json()];}
test('IT-API-SETUP: start server',async()=>{cp=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,ATS_PORT:String(port),ATS_DATA_DIR:data},stdio:'ignore'});await ready();const r=await api('/api/session');token=r[1].token;assert.ok(token);});
test('IT-SEC-001: rejects unauthenticated API',async()=>{const r=await api('/api/projects','GET',undefined,false);assert.equal(r[0],401);});
test('IT-API-001: add existing repository',async()=>{const r=await api('/api/projects','POST',{path:base});assert.equal(r[0],201);projectId=r[1].project.id;});
test('IT-API-002: import and index tests',async()=>{const r=await api(`/api/projects/${projectId}/tests`);assert.equal(r[0],200);assert.equal(r[1].tests.length,2);});
test('IT-SEC-002: rejects foreign origin',async()=>{const r=await fetch(`http://127.0.0.1:${port}/api/session`,{headers:{Origin:'https://evil.example'}});assert.equal(r.status,403);});
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
test('IT-API-013: the pinned and unpinned success responses have the SAME negotiation shape',async()=>{
 const unpinned=await api(`/api/projects/${projectId}/runners`,'POST',{capabilities:['discover','start','stop','collect']});
 assert.equal(unpinned[0],200);
 const pinned=await api(`/api/projects/${projectId}/runners`,'POST',{runner:'playwright',capabilities:['discover','start','stop','collect']});
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
test('IT-API-CLEANUP: stop and cleanup',()=>{cp.kill();fs.rmSync(data,{recursive:true,force:true});fs.rmSync(noDeps,{recursive:true,force:true});});
