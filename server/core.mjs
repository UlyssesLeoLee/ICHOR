import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { parseCliOptions, probeCommand } from './adapters/contract.mjs';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const safeId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
export const dataDir = () => path.resolve(process.env.ATS_DATA_DIR || path.join(os.homedir(), '.ai-test-studio'));
export const now = () => new Date().toISOString();
export function ensureData() { fs.mkdirSync(path.join(dataDir(),'runs'), {recursive:true}); }
export function loadState() {
  ensureData(); const name=path.join(dataDir(),'state.json');
  if (!fs.existsSync(name)) return {schema:1, projects:[], runs:[]};
  const v=JSON.parse(fs.readFileSync(name,'utf8'));
  if (v.schema!==1 || !Array.isArray(v.projects) || !Array.isArray(v.runs)) throw new Error('UNSUPPORTED_DATABASE');
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
export function discoverStatic(project) {
 const files=walkTests(project.root);const tests=[];
 for(const file of files){
   const content=fs.readFileSync(path.join(project.root,file),'utf8');
   const re=/(?:^|\n)\s*(?:test|it)(?:\.(?:only|skip|fixme))?\s*\(\s*(['"`])([^\n]*?)\1/g;
   let m;while((m=re.exec(content))!==null){
     const title=m[2].slice(0,180),line=content.slice(0,m.index).split('\n').length;
     tests.push({id:sha(`${project.id}:${file}:${title}`).slice(0,16),file,title,line,source:'static',level:'ST'});
   }
 }
 return {files,tests,discovery:'static',warning:'静态索引仅识别常见 test()/it() 形式；动态、参数化、fixture 测试请以 Playwright --list 为准。'};
}
export function resolvePlaywright(project) {
 const candidates=['node_modules/@playwright/test/cli.js','node_modules/playwright/cli.js','node_modules/playwright-core/cli.js'];
 for(const c of candidates){const p=path.join(project.root,c);if(fs.existsSync(p))return p;}
 return null;
}
/**
 * The Playwright CLI options the INSTALLED CLI actually accepts.
 *
 * ATS-101 defect B-01 was that the argument vector was written by hand and
 * contained two options (`--screenshot`, `--video`) that `playwright test`
 * does not have -- the CLI rejected the whole vector and the run died during
 * argument parsing. The option set of the installed CLI is now the contract:
 * an option is only passed when the CLI declares it.
 */
export function playwrightCliOptions(project) {
 const cli=resolvePlaywright(project);
 if(!cli)return null;
 const help=probeCommand(process.execPath,[cli,'test','--help'],{cwd:project.root});
 if(!help.ok)return null;
 return parseCliOptions(help.stdout);
}
export function safeRunArgs(project,testFile,output) {
 const cli=resolvePlaywright(project);
 if(!cli)throw new Error('PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT');
 const options=playwrightCliOptions(project)||[];
 const args=[cli,'test'];
 if(options.includes('reporter'))args.push('--reporter=line,json,html');
 if(options.includes('output'))args.push('--output',path.join(output,'results'));
 if(options.includes('trace'))args.push('--trace','on');
 if(options.includes('workers'))args.push('--workers','1');
 if(testFile){sourcePath(project,testFile); args.push(testFile);}return args;
}
export function runDir(id){if(!/^run_[0-9a-f-]{36}$/.test(id)) throw new Error('INVALID_RUN_ID');return path.join(dataDir(),'runs',id);}
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
export function parseReport(report){
 let passed=0,failed=0,skipped=0,flaky=0;const cases=[];
 function walk(s){for(const x of s.specs||[]){for(const t of x.tests||[]){
  const status=t.status||'unknown';if(['expected'].includes(status))passed++;else if(status==='flaky')flaky++;else if(status==='skipped')skipped++;else failed++;
  cases.push({title:x.title,file:s.file||'',status,duration:(t.results||[]).reduce((a,b)=>a+(b.duration||0),0),error:t.results?.find(r=>r.error)?.error?.message||''});
 }}for(const sub of s.suites||[])walk(sub);}
 for(const suite of report.suites||[])walk(suite);
 return {passed,failed,skipped,flaky,total:cases.length,cases};
}
export function compactLog(log){return log.length>150000?log.slice(-150000):log;}
