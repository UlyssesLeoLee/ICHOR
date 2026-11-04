import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { projectUidFor, projectUidOf, resolveIdentities, extractCallbackBody, UID_SCHEME_VERSION, emptyRegistry, attemptUidFor, findTestUid, normalizeTestPath } from './uid.mjs';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const safeId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
export const dataDir = () => path.resolve(process.env.ATS_DATA_DIR || path.join(os.homedir(), '.ai-test-studio'));
export const now = () => new Date().toISOString();
export function ensureData() { fs.mkdirSync(path.join(dataDir(),'runs'), {recursive:true}); }
export function loadState() {
  ensureData(); const name=path.join(dataDir(),'state.json');
  if (!fs.existsSync(name)) return {schema:1, projects:[], runs:[], uidRegistry:emptyRegistry()};
  const v=JSON.parse(fs.readFileSync(name,'utf8'));
  if (v.schema!==1 || !Array.isArray(v.projects) || !Array.isArray(v.runs)) throw new Error('UNSUPPORTED_DATABASE');
  // The UID registry is additive: a state file written before ATS-201 has no
  // registry and is loaded with an empty one, so old installations keep
  // working until the migration script rewrites their identifiers.
  if (!v.uidRegistry || typeof v.uidRegistry!=='object') v.uidRegistry=emptyRegistry();
  return v;
}
export function saveState(v) {
  ensureData(); const file=path.join(dataDir(),'state.json'), tmp=file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(v,null,2),'utf8'); fs.renameSync(tmp,file);
}
export function validateProjectPath(input) {
  if(typeof input!=='string'||input.length>1024) throw new Error('INVALID_PROJECT_PATH');
  const actual=fs.realpathSync(path.resolve(input));
  if(!fs.statSync(actual).isDirectory()) throw new Error('NOT_A_DIRECTORY');
  if(!fs.existsSync(path.join(actual,'package.json'))) throw new Error('PROJECT_PACKAGE_JSON_REQUIRED');
  if(!fs.readdirSync(actual).some(n=>/^playwright\.config\.[cm]?[jt]s$/.test(n))) throw new Error('PLAYWRIGHT_CONFIG_REQUIRED');
  return actual;
}
export function gitInfo(root) {
  function git(...args) {let a=spawnSync('git',['-C',root,...args],{encoding:'utf8',timeout:4000});return a.status===0?a.stdout.trim():'';}
  return {branch:git('branch','--show-current')||'detached / none',commit:git('rev-parse','--short','HEAD')||'untracked',dirty:Boolean(git('status','--porcelain'))};
}
export function isSubpath(root,other) {const rel=path.relative(root,other); return rel!=='' && rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}
export function sourcePath(project,relative) {
  if(typeof relative!=='string'||relative.length>500 || !/\.(spec|test)\.[cm]?[jt]sx?$/.test(relative)) throw new Error('INVALID_SOURCE_FILE');
  const joined=path.resolve(project.root,relative);
  if(!isSubpath(project.root,joined)) throw new Error('PATH_OUTSIDE_PROJECT');
  const actual=fs.realpathSync(joined);
  if(!isSubpath(project.root,actual)||!fs.statSync(actual).isFile())throw new Error('PATH_OUTSIDE_PROJECT');
  if(fs.statSync(actual).size>1_000_000) throw new Error('SOURCE_TOO_LARGE');
  return actual;
}
export function readSource(project,relative) {const f=sourcePath(project,relative); const content=fs.readFileSync(f,'utf8');return {file:relative, content, hash:sha(content)};}
export function writeSource(project,relative,content,baseHash) {
  if(typeof content!=='string'||Buffer.byteLength(content)>1_000_000||typeof baseHash!=='string')throw new Error('INVALID_SOURCE_UPDATE');
  const p=sourcePath(project,relative),before=fs.readFileSync(p,'utf8');
  if(sha(before)!==baseHash)throw new Error('STALE_EDIT_CONFLICT');
  fs.writeFileSync(p,content,'utf8');return {file:relative,hash:sha(content),changed:before!==content};
}
export function walkTests(root,rel='',depth=0,acc=[]) {
  if(depth>14||acc.length>2000)return acc;
  const dir=path.join(root,rel);
  for(const ent of fs.readdirSync(dir,{withFileTypes:true})) {
    if(['node_modules','.git','.next','out','dist','target','test-results','playwright-report','.aitest-studio','coverage'].includes(ent.name))continue;
    const child=path.join(rel,ent.name);
    if(ent.isDirectory())walkTests(root,child,depth+1,acc);
    else if(ent.isFile()&&/\.(spec|test)\.[cm]?[jt]sx?$/.test(ent.name))acc.push(child.replace(/\\/g,'/'));
  }return acc;
}
export function discoverStatic(project, registry) {
 const files=walkTests(project.root);const discovered=[];
 for(const file of files){
   const content=fs.readFileSync(path.join(project.root,file),'utf8');
   const re=/(?:^|\n)[ \t]*(?:test|it)(?:\.(?:only|skip|fixme))?\s*\(\s*(['"`])([^\n]*?)\1/g;
   let m;while((m=re.exec(content))!==null){
     // The line of the `test(` call itself, not the line of the whitespace
     // that precedes it: a Playwright report numbers the line of the call.
     const title=m[2].slice(0,180);
     const line=content.slice(0,m.index+m[0].length).split('\n').length;
     const body=extractCallbackBody(content,m.index+m[0].length);
     discovered.push({file,title,line,bodyText:body.text});
   }
 }
 const projectUid=projectUidOf(project);
 const resolved=resolveIdentities({projectUid,discovered,registry});
 const tests=resolved.items.map(t=>({
   id:t.uid,uid:t.uid,uidSource:t.uidSource,uidStable:t.uidStable,
   file:t.file,title:t.title,line:t.line,source:'static',level:'ST',
   ...(t.ambiguity?{ambiguity:t.ambiguity}:{})
 }));
 const ambiguous=tests.filter(t=>!t.uidStable).length;
 return {files,tests,discovery:'static',uidVersion:UID_SCHEME_VERSION,projectUid,registry:resolved.registry,
   warning:'静态索引仅识别常见 test()/it() 形式；动态、参数化、fixture 测试请以 Playwright --list 为准。'
     +(ambiguous?` ${ambiguous} 个用例的 UID 为临时值（标题重复且无法唯一判定），需要用 @TC-xxx 显式标注或人工复核。`:'')};
}
export function resolvePlaywright(project) {
 const candidates=['node_modules/@playwright/test/cli.js','node_modules/playwright/cli.js','node_modules/playwright-core/cli.js'];
 for(const c of candidates){const p=path.join(project.root,c);if(fs.existsSync(p))return p;}
 return null;
}
export function safeRunArgs(project,testFile,output) {
 const cli=resolvePlaywright(project);
 if(!cli)throw new Error('PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT');
 const args=[cli,'test','--reporter=line,json,html','--output',path.join(output,'results'),'--trace','on','--screenshot','only-on-failure','--video','retain-on-failure','--workers','1'];
 if(testFile){sourcePath(project,testFile); args.push(testFile);}return args;
}
export function runDir(id){if(!/^run_(?:[0-9a-f-]{36}|1_[0-9a-f]{24})$/.test(id)) throw new Error('INVALID_RUN_ID');return path.join(dataDir(),'runs',id);}
export function filesInRun(id){const root=runDir(id);const result=[];
 function recur(dir,depth){if(depth>8||result.length>400)return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const full=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())recur(full,depth+1);else if(entry.isFile()){
  const stat=fs.statSync(full),relative=path.relative(root,full).replace(/\\/g,'/');if(stat.size>50_000_000)continue;
  result.push({file:relative,size:stat.size,sha256:sha(fs.readFileSync(full))});}
 }}if(fs.existsSync(root))recur(root,0);return result;
}
export function artifactPath(id,relative){
 const root=runDir(id);if(typeof relative!=='string'||relative.length>500)throw new Error('INVALID_ARTIFACT_PATH');
 const full=path.resolve(root,relative);if(!isSubpath(root,full))throw new Error('PATH_OUTSIDE_RUN');
 const actual=fs.realpathSync(full);if(!isSubpath(root,actual)||!fs.statSync(actual).isFile())throw new Error('PATH_OUTSIDE_RUN');return actual;
}
/**
 * Parses a Playwright JSON report into the run summary.
 *
 * Two details of the report format matter for the UID scheme:
 *
 *   * `spec.file` is relative to the Playwright `rootDir`, which is derived
 *     from `testDir`. The registry stores the file relative to the project
 *     root, so the report's `rootDir` is reported alongside the cases and the
 *     two spellings are reconciled by the caller.
 *   * a retried test case is ONE entry in `spec.tests[]` whose `results[]`
 *     array holds one element per retry. Every retry is a separate execution
 *     of the case, so every retry becomes its own case record here.
 */
export function parseReport(report){
 let passed=0,failed=0,skipped=0,flaky=0;const cases=[];
 function walk(s){for(const x of s.specs||[]){for(const t of x.tests||[]){
  const status=t.status||'unknown';if(['expected'].includes(status))passed++;else if(status==='flaky')flaky++;else if(status==='skipped')skipped++;else failed++;
  const results=Array.isArray(t.results)&&t.results.length?t.results:[{}];
  const file=x.file||s.file||'';
  results.forEach((r,index)=>{
   cases.push({title:x.title,file,status,duration:r.duration||0,error:r.error?.message||'',retry:Number.isInteger(r.retry)?r.retry:index,line:x.line||null,column:x.column||null});
  });
 }}for(const sub of s.suites||[])walk(sub);}
 for(const suite of report.suites||[])walk(suite);
 const rootDir=report?.config?.rootDir||null;
 // `total` counts the test cases of the run, the same unit as passed / failed /
 // skipped / flaky. A retried case is still ONE case; its retries are counted
 // separately as `executions`, because each retry is a separate execution.
 const total=passed+failed+skipped+flaky;
 return {passed,failed,skipped,flaky,total,executions:cases.length,cases,rootDir};
}

/**
 * Builds the Attempt records of one Run.
 *
 * One Attempt is the execution of one test case inside one Run; a retried
 * case produces one Attempt per retry. The Attempt UID is derived from the
 * Run UID, the TestDefinition UID, the retry index and the occurrence index
 * of the case inside the report, so the same attempt can be recomputed from
 * the recorded fields (that is what the migration script relies on).
 *
 * `registry` supplies the mapping from a reported case to the stable
 * TestDefinition UID. A case that cannot be bound unambiguously keeps
 * `testUid: null` and records the reason in `uidBasis`.
 */
export function attemptsForRun(run, summary, registry) {
  if (!summary || !Array.isArray(summary.cases)) return [];
  const projectUid = run.projectUid ?? '';
  const projectRoot = run.projectRoot ?? null;
  const rootDir = summary.rootDir ?? null;
  const occurrence = new Map();
  const attempts = [];
  for (const c of summary.cases) {
    // The report names the file relative to the Playwright rootDir, the
    // registry stores it relative to the project root. Both are reduced to
    // the project relative spelling before they are compared.
    const file = normalizeTestPath(c.file, { rootDir, projectRoot });
    const found = findTestUid(registry, projectUid, { file, title: c.title, line: c.line });
    const key = `${file} ${c.title} ${c.line}`;
    const index = occurrence.get(key) ?? 0;
    occurrence.set(key, index + 1);
    attempts.push({
      uid: attemptUidFor({
        runUid: run.uid || run.id,
        testUid: found.uid,
        retry: c.retry,
        fallbackKey: `${file} ${c.title} ${c.line}`,
        occurrence: index
      }),
      runUid: run.uid || run.id,
      testUid: found.uid,
      uidBasis: found.basis,
      file,
      title: c.title,
      line: c.line,
      retry: c.retry || 0,
      status: c.status,
      duration: c.duration,
      error: c.error || ''
    });
  }
  return attempts;
}
export function compactLog(log){return log.length>150000?log.slice(-150000):log;}
