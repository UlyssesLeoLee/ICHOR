import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';
const root=path.resolve(import.meta.dirname,'..');
const base=path.resolve(root,'examples/sample-playwright');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'ats-api-'));const port=await freePort();
let cp,token,projectId;
async function ready(){for(let i=0;i<80;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('server did not boot');}
async function api(endpoint,method='GET',payload,auth=true){const r=await fetch(`http://127.0.0.1:${port}`+endpoint,{method,headers:auth?{'X-ATS-Token':token,'Content-Type':'application/json'}:{},body:payload?JSON.stringify(payload):undefined});return [r.status,await r.json()];}
test('IT-API-SETUP: start server',async()=>{cp=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,ATS_PORT:String(port),ATS_DATA_DIR:data},stdio:'ignore'});await ready();const r=await api('/api/session');token=r[1].token;assert.ok(token);});
test('IT-SEC-001: rejects unauthenticated API',async()=>{const r=await api('/api/projects','GET',undefined,false);assert.equal(r[0],401);});
test('IT-API-001: add existing repository',async()=>{const r=await api('/api/projects','POST',{path:base});assert.equal(r[0],201);projectId=r[1].project.id;});
test('IT-API-002: import and index tests',async()=>{const r=await api(`/api/projects/${projectId}/tests`);assert.equal(r[0],200);assert.equal(r[1].tests.length,2);});
test('IT-SEC-002: rejects foreign origin',async()=>{const r=await fetch(`http://127.0.0.1:${port}/api/session`,{headers:{Origin:'https://evil.example'}});assert.equal(r.status,403);});
test('IT-RUN-001: no deps => explicit failure rather than fake success',async()=>{const r=await api(`/api/projects/${projectId}/run`,'POST',{});assert.equal(r[0],202);assert.equal(r[1].run.status,'error');});
test('IT-API-003: runs survive persisted read',async()=>{const r=await api('/api/runs');assert.equal(r[1].runs.length,1);assert.equal(r[1].runs[0].status,'error');});
test('IT-API-CLEANUP: stop and cleanup',()=>{cp.kill();fs.rmSync(data,{recursive:true,force:true});});
