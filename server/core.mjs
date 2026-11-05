import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { projectUidFor, projectUidOf, resolveIdentities, extractCallbackBody, scanTestCases, UID_SCHEME_VERSION, emptyRegistry, attemptUidFor, findTestUid, normalizeTestPath, bodyKeyOf } from './uid.mjs';
import { buildPlaywrightArgs, probePlaywrightCli } from './adapters/playwright-cli.mjs';

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

/* ------------------------------------------------------------------ */
/* Data directory lock                                                */
/* ------------------------------------------------------------------ */

/**
 * The lock file of the data directory.
 *
 * The state file and the run folders are ONE piece of state: the Bridge
 * writes `state.json` and renames the run folders, and the migration script
 * rewrites both. When the two run at the same time, the Bridge overwrites
 * the migrated `state.json` with its own in-memory copy -- which still holds
 * the OLD identifiers -- while the folders on disk are already renamed. The
 * result is a state that points at run folders that no longer exist.
 *
 * The lock is therefore EXCLUSIVE and it is held for the whole lifetime of
 * the Bridge, and for the whole duration of a migration. The migration
 * refuses to run while the Bridge holds it, and the Bridge refuses to start
 * while a migration holds it.
 */
export const lockPath = (dir = dataDir()) => path.join(dir, 'bridge.lock');

/** True when the process is still running. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/**
 * The start time of a process, as the operating system reports it.
 *
 * The start time is what makes a process identifier VERIFIABLE: a pid alone
 * does not identify a process, because the operating system reuses pids. The
 * pair (pid, start time) does -- as long as both are read with the same
 * source, the same process always yields the same value.
 *
 * Returns null when the process does not exist or when the platform cannot
 * report the value.
 */
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString("o")`
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const out = (r.stdout ?? '').trim();
    return out || null;
  }
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10000 });
  const out = (r.stdout ?? '').trim();
  return out || null;
}

/**
 * The holder of the lock, or null when the lock is free.
 *
 * A lock is free when it cannot be attributed to a live holder:
 *
 *   * the file does not exist, or it cannot be parsed;
 *   * the recorded pid is gone -- the process was killed and left the file
 *     behind. That is a STALE lock, and it does not block anybody;
 *   * the recorded pid is alive but it is a DIFFERENT process than the one
 *     that took the lock -- the pid was reused. That is a STALE lock too, and
 *     it does not block anybody.
 *
 * The last case is the reason the lock records the start time of the holder:
 * without it, a reused pid looks exactly like a live holder and a leftover
 * lock file keeps the Bridge from starting.
 *
 * A lock that carries no verifiable identity -- one written by an older
 * version, or by hand -- is reported as HELD: its holder cannot be told from
 * a reused pid, and the state it guards may really be in use. The caller
 * answers such a lock with the recovery steps, not with a guess.
 */
export function readBridgeLock(file = lockPath()) {
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
  if (!raw || !Number.isInteger(raw.pid)) return null;
  if (!isProcessAlive(raw.pid)) return null;
  // The holder is alive. Is it the process that took the lock?
  if (raw.processStartedAt) {
    const now = processStartTime(raw.pid);
    // The pid is alive but its start time is not the recorded one: the pid
    // was reused by another process, so the lock is stale.
    if (now !== null && now !== raw.processStartedAt) return null;
  }
  return raw;
}

/**
 * Acquires the exclusive lock of the data directory.
 * Throws `BRIDGE_ALREADY_RUNNING` when a live process holds it.
 */
export function acquireBridgeLock(file = lockPath()) {
  const holder = readBridgeLock(file);
  if (holder) {
    const e = new Error('BRIDGE_ALREADY_RUNNING');
    e.code = 'BRIDGE_ALREADY_RUNNING';
    e.holder = holder;
    throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The start time of this process makes the lock verifiable: the next reader
  // can tell that the recorded pid is still THIS process and not a process
  // that happens to reuse the pid.
  fs.writeFileSync(file, JSON.stringify({
    pid: process.pid,
    startedAt: now(),
    processStartedAt: processStartTime(process.pid)
  }), 'utf8');
  return file;
}

/** Releases the lock -- but only when this process is the holder. */
export function releaseBridgeLock(file = lockPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.pid === process.pid) fs.rmSync(file, { force: true });
  } catch { /* the lock is not ours, or it is already gone */ }
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
   for(const c of scanTestCases(content))discovered.push({file,...c});
 }
 const projectUid=projectUidOf(project);
 // The scope of this discovery is the set of files it covered. The registry
 // only prunes entries whose file is INSIDE the scope: a file that is not part
 // of this discovery says nothing about the cases inside it, and pruning its
 // entries would drop the identity of a case that still exists.
 const resolved=resolveIdentities({projectUid,discovered,registry,scope:new Set(files)});
 const tests=resolved.items.map(t=>({
   id:t.uid,uid:t.uid,uidSource:t.uidSource,uidStable:t.uidStable,
   file:t.file,title:t.title,line:t.line,source:'static',level:'ST',
   ...(t.ambiguity?{ambiguity:t.ambiguity}:{})
 }));
 const ambiguous=tests.filter(t=>!t.uidStable).length;
 // Every kind of uncertainty is REPORTED. A case that got a uid but whose
 // registry entry disagreed with it is reported as well: the uid is usable,
 // but the memory of the past cases is inconsistent and a reader has to know.
 const conflicts=tests.filter(t=>t.ambiguity&&t.ambiguity.reason!=='identical-title'&&t.ambiguity.reason!=='identical-title-and-body');
 const duplicatedExplicit=tests.filter(t=>t.ambiguity?.reason==='duplicate-explicit-uid').length;
 let warning='静态索引仅识别常见 test()/it() 形式；动态、参数化、fixture 测试请以 Playwright --list 为准。';
 if(ambiguous)warning+=` ${ambiguous} 个用例的 UID 为临时值（标题重复且无法唯一判定），需要用 @TC-xxx 显式标注或人工复核。`;
 if(duplicatedExplicit)warning+=` ${duplicatedExplicit} 个用例标注了同一个 @TC-xxx（重复的显式 UID），这些用例都没有绑定到该 UID，需要人工消歧。`;
 if(conflicts.length)warning+=` ${conflicts.length} 个用例的注册表记录与本次发现不一致（${[...new Set(conflicts.map(t=>t.ambiguity.reason))].join('、')}），其 UID 由本次发现派生，需要人工复核。`;
 return {files,tests,discovery:'static',uidVersion:UID_SCHEME_VERSION,projectUid,registry:resolved.registry,warning};
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
 *
 * The implementation lives in adapters/playwright-cli.mjs so that this
 * helper and the ATS-301 adapter cannot drift apart.
 */
export function playwrightCliOptions(project) {
 const probe=probePlaywrightCli(project.root);
 return probe?probe.options:null;
}
/**
 * The options to pass when the installed CLI's --help could not be parsed.
 * Mirrors FALLBACK_PLAYWRIGHT_OPTIONS in the adapter: the run must keep
 * behaving the way it always has (artefacts + report), but the capability
 * report stays honest about what was proven.
 */
const FALLBACK_CLI_OPTIONS=['reporter','output','trace','workers'];
export function safeRunArgs(project,testFile,output) {
 const cli=resolvePlaywright(project);
 if(!cli)throw new Error('PLAYWRIGHT_NOT_INSTALLED_RUN_NPM_INSTALL_IN_PROJECT');
 const probed=playwrightCliOptions(project);
 const options=(probed&&probed.length)?probed:FALLBACK_CLI_OPTIONS;
 const args=buildPlaywrightArgs({cli,options,output,testFile});
 if(testFile)sourcePath(project,testFile);
 return args;
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
 *
 * The two LEVELS of status are kept apart, because they answer different
 * questions:
 *
 *   * `status` -- the CASE level status (`expected` / `unexpected` / `flaky` /
 *     `skipped`). It describes the case as a whole: a flaky case is `flaky`
 *     even though its first retry failed.
 *   * `resultStatus` -- the RESULT level status of THIS execution
 *     (`passed` / `failed` / `timedOut` / `skipped` / `interrupted`). It
 *     describes the single execution: the first retry of a flaky case failed,
 *     the second passed.
 *
 * An Attempt is one EXECUTION, so it records the result level status. The
 * case level status would report "flaky" for both attempts and hide that the
 * first one actually failed.
 */
export function parseReport(report){
 let passed=0,failed=0,skipped=0,flaky=0;const cases=[];
 function walk(s){for(const x of s.specs||[]){for(const t of x.tests||[]){
  const status=t.status||'unknown';if(['expected'].includes(status))passed++;else if(status==='flaky')flaky++;else if(status==='skipped')skipped++;else failed++;
  const results=Array.isArray(t.results)&&t.results.length?t.results:[{}];
  const file=x.file||s.file||'';
  results.forEach((r,index)=>{
   cases.push({title:x.title,file,status,resultStatus:r.status??status,duration:r.duration||0,error:r.error?.message||'',retry:Number.isInteger(r.retry)?r.retry:index,line:x.line||null,column:x.column||null});
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
 * The body fingerprint of the case a report names.
 *
 * A report names a case by file, title and line. The source of the file is
 * read and scanned, and the case that sits at the reported line with the
 * reported title is located; its body is fingerprinted. The fingerprint is
 * what tells two cases that share a title apart.
 *
 * Returns null when the file cannot be read, when the case is not in the file
 * any more, or when several cases share the title and the line does not pick
 * one of them. A null fingerprint leaves the case unbound, which is the honest
 * answer: it is better to report no UID than the UID of a different case.
 *
 * `cache` holds the scanned cases per file, so a file is read and scanned at
 * most once per run.
 */
export function reportedBodyKey(projectRoot, file, reported, cache = new Map()) {
  if (!projectRoot || !file) return null;
  let cases = cache.get(file);
  if (cases === undefined) {
    let content = null;
    try {
      const full = path.resolve(projectRoot, file);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) content = fs.readFileSync(full, 'utf8');
    } catch { content = null; }
    cases = content === null ? null : scanTestCases(content);
    cache.set(file, cases);
  }
  if (!cases) return null;
  const titled = cases.filter((x) => x.title === reported.title);
  if (!titled.length) return null;
  if (titled.length === 1) return bodyKeyOf(titled[0].bodyText ?? null);
  // Several cases share the title: the reported line picks one of them.
  const atLine = titled.filter((x) => x.line === reported.line);
  if (atLine.length === 1) return bodyKeyOf(atLine[0].bodyText ?? null);
  return null;
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
  const bodyCache = new Map();
  const attempts = [];
  for (const c of summary.cases) {
    // The report names the file relative to the Playwright rootDir, the
    // registry stores it relative to the project root. Both are reduced to
    // the project relative spelling before they are compared.
    const file = normalizeTestPath(c.file, { rootDir, projectRoot });
    // A title that several cases in the same file share does not identify one
    // of them, and the line cannot make it one: the case at the reported line
    // may be a different case than the one that was there when the registry
    // was written. The BODY FINGERPRINT of the reported case is what tells
    // them apart, so it is computed from the source of THIS run and handed to
    // the lookup. The source is read only when the file is known and only
    // once per file.
    const found = findTestUid(registry, projectUid, {
      file,
      title: c.title,
      line: c.line,
      resolveBodyKey: () => reportedBodyKey(projectRoot, file, c, bodyCache)
    });
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
      // An Attempt is one EXECUTION, so it records the result level status.
      // The case level status (`flaky`) would describe the case as a whole and
      // would report "flaky" for the failed retry as well.
      status: c.resultStatus ?? c.status,
      caseStatus: c.status,
      duration: c.duration,
      error: c.error || ''
    });
  }
  return attempts;
}
export function compactLog(log){return log.length>150000?log.slice(-150000):log;}
