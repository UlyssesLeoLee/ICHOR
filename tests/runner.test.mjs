import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import { freePort } from './helpers/free-port.mjs';
const root=path.resolve(import.meta.dirname,'..');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ats-run-'));
const project=path.join(dir,'fake-pw'),data=path.join(dir,'data'),port=await freePort();fs.mkdirSync(path.join(project,'node_modules','@playwright','test'),{recursive:true});fs.mkdirSync(path.join(project,'tests'));fs.writeFileSync(path.join(project,'package.json'),'{}');fs.writeFileSync(path.join(project,'playwright.config.ts'),'export default {}');fs.writeFileSync(path.join(project,'tests','pass.spec.ts'),"test('simulated success', ()=>{});\n");
// NOT Playwright itself. A test-only CLI double to exercise reporter transport, persistence and artifact paths.
fs.writeFileSync(path.join(project,'node_modules','@playwright','test','cli.js'),`
const fs=require('fs'),path=require('path');const args=process.argv.slice(2);const result=process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;const folder=path.dirname(result);
const output=args[args.indexOf('--output')+1];fs.mkdirSync(output,{recursive:true});
if(args.includes('slow.spec.ts'))setTimeout(()=>{console.log('late completion')},5000);
else {
 fs.writeFileSync(result, JSON.stringify({suites:[{file:'tests/pass.spec.ts',specs:[{title:'simulated success',tests:[{status:'expected',results:[{duration:29}]}]}]}]}));
 fs.mkdirSync(path.join(folder,'html'),{recursive:true});fs.writeFileSync(path.join(folder,'html','index.html'),'<h1>fixture report</h1>');
 fs.writeFileSync(path.join(output,'fixture-trace.zip'),'not a real trace');
 console.log('test-double: one passing case');
}
`);
fs.writeFileSync(path.join(project,'tests','slow.spec.ts'),"test('simulated slow',()=>{});");
let cp,token,id;
async function ready(){for(let i=0;i<70;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)return}catch{}await new Promise(r=>setTimeout(r,35));}throw Error('bridge unreachable');}
async function req(endpoint,method='GET',body){const r=await fetch(`http://127.0.0.1:${port}${endpoint}`,{method,headers:token?{'X-ATS-Token':token,'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return [r.status,await r.json()];}
async function waitRun(id,status){for(let i=0;i<100;i++){let r=(await req('/api/runs/'+id))[1].run;if(r.status===status)return r;if(['error','failed','cancelled'].includes(r.status)&&r.status!==status)throw Error(`unexpected ${r.status}: ${r.error}`);await new Promise(r=>setTimeout(r,35));}throw Error('run timeout');}
test('IT-RUN-MOCK-SETUP: isolated fake CLI adapter',async()=>{cp=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,ATS_PORT:String(port),ATS_DATA_DIR:data},stdio:'ignore'});await ready();token=(await req('/api/session'))[1].token;id=(await req('/api/projects','POST',{path:project}))[1].project.id;assert.ok(id);});
test('IT-RUN-MOCK-001: Run->JSON->manifest->artifact roundtrip',async()=>{
 const [code,body]=await req(`/api/projects/${id}/run`,'POST',{file:'tests/pass.spec.ts'});assert.equal(code,202);const r=await waitRun(body.run.id,'passed');assert.equal(r.summary.total,1);assert.equal(r.summary.passed,1);assert.ok(r.artifacts.some(x=>x.file==='report.json'));assert.ok(r.artifacts.some(x=>x.file.includes('fixture-trace.zip')));
 const events=(await req(`/api/runs/${r.id}/events`))[1].events;assert.deepEqual(events.map(x=>x.seq),[1,2,3]);assert.equal(events.at(-1).type,'run.finished');
 const manifest=JSON.parse(fs.readFileSync(path.join(data,'runs',r.id,'manifest.json')));assert.equal(manifest.runId,r.id);assert.equal(manifest.status,'passed');
 const pathIn=path.join(data,'runs',r.id,'results','fixture-trace.zip');assert.equal(fs.readFileSync(pathIn,'utf8'),'not a real trace');
});
test('IT-RUN-MOCK-002: cancel marks cancelled',async()=>{const r=(await req(`/api/projects/${id}/run`,'POST',{file:'tests/slow.spec.ts'}))[1].run;await req(`/api/runs/${r.id}/stop`,'POST');const done=await waitRun(r.id,'cancelled');assert.equal(done.status,'cancelled');});
test('IT-RUN-MOCK-CLEANUP: cleanup',()=>{cp.kill();fs.rmSync(dir,{recursive:true,force:true});});
