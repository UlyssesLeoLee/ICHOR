import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateProjectPath,discoverStatic,readSource,writeSource,sourcePath,sha,parseReport,safeRunArgs } from '../server/core.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ats-ut-'));
const projectDir=path.join(dir,'app');fs.mkdirSync(path.join(projectDir,'tests'),{recursive:true});
fs.writeFileSync(path.join(projectDir,'package.json'),'{}');fs.writeFileSync(path.join(projectDir,'playwright.config.ts'),'export default {}');
fs.writeFileSync(path.join(projectDir,'tests','login.spec.ts'),"test('login passes', async ({page}) => { await page.goto('https://example.com'); });\n");
const project={id:'proj_demo',root:projectDir};
test('UT-CORE-001: validates Playwright project',()=>assert.equal(validateProjectPath(projectDir),fs.realpathSync(projectDir)));
test('UT-CORE-002: extracts static test index',()=>{const d=discoverStatic(project);assert.equal(d.tests.length,1);assert.equal(d.tests[0].title,'login passes');});
test('UT-SEC-001: rejects path traversal',()=>{assert.throws(()=>sourcePath(project,'../../outside.spec.ts'));assert.throws(()=>sourcePath(project,'README.md'));});
test('UT-CORE-003: conditional save avoids lost updates',()=>{
 const s=readSource(project,'tests/login.spec.ts');assert.equal(s.hash,sha(s.content));
 const r=writeSource(project,s.file,s.content+'// new\n',s.hash);assert.notEqual(r.hash,s.hash);
 assert.throws(()=>writeSource(project,s.file,'oops',s.hash),/STALE_EDIT_CONFLICT/);
});
test('UT-CORE-004: malformed project rejected',()=>assert.throws(()=>validateProjectPath(dir),/PROJECT_PACKAGE_JSON_REQUIRED/));
test('UT-RUN-001: missing local Playwright never auto-installs',()=>assert.throws(()=>safeRunArgs(project,null,dir),/PLAYWRIGHT_NOT_INSTALLED/));
test('UT-RPT-001: report summary counts passed/failed/skipped',()=>{
 const r=parseReport({suites:[{file:'tests/a.spec.ts',specs:[{title:'A',tests:[{status:'expected',results:[{duration:4}]}]},{title:'B',tests:[{status:'unexpected',results:[{duration:8,error:{message:'boom'}}]}]},{title:'C',tests:[{status:'skipped',results:[]}]}]}]});
 assert.deepEqual([r.total,r.passed,r.failed,r.skipped],[3,1,1,1]);assert.equal(r.cases[1].error,'boom');
});
test('UT-CORE-005: removes generated fixture',()=>{fs.rmSync(dir,{recursive:true,force:true});assert.equal(fs.existsSync(dir),false);});
