import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { projectUidFor, projectUidOf, resolveIdentities, extractCallbackBody, scanTestCases, UID_SCHEME_VERSION, emptyRegistry, attemptUidFor, findTestUid, normalizeTestPath, bodyKeyOf } from './uid.mjs';
import { buildPlaywrightArgs, probePlaywrightCli } from './adapters/playwright-cli.mjs';
import { openDatabase as openMetadataDatabase } from './sqlite/db.mjs';
import { storeState } from './sqlite/store.mjs';
import { listTests, listTestsAsync, LIST_OUTCOME } from './discovery/playwright-list.mjs';
import { resolveAuthoritativeIdentities } from './discovery/authoritative.mjs';
import { compareDiscoveries, readBodies, staticCasesWithScope, DISCOVERY } from './discovery/index.mjs';
import { TRUST, trustOf } from './discovery/trust.mjs';
// ATS-208: the unified Run/Test/Attempt/ExecutionEvent model. The report
// parsing, the attempt building and the status vocabulary live THERE, so
// that the bridge, the adapters and the SQLite layer describe a run in ONE
// way. The functions below are re-exported from this module so that the
// existing callers keep working.
import {
  CASE_STATUS,
  EVENT_TYPE,
  RESULT_STATUSES,
  RUN_STATUS,
  aggregateCases,
  aggregateAttempts,
  attemptsForRun,
  caseIdentity,
  isAllowedTransition,
  isTerminalRunStatus,
  mapEngineStatus,
  nextEventSeq,
  parseReport,
  replayEvents,
  reportedBodyKey,
  runView,
  statusOfEvent,
} from './execution/model.mjs';

export {
  CASE_STATUS,
  EVENT_TYPE,
  RESULT_STATUSES,
  RUN_STATUS,
  aggregateCases,
  aggregateAttempts,
  attemptsForRun,
  caseIdentity,
  isAllowedTransition,
  isTerminalRunStatus,
  mapEngineStatus,
  nextEventSeq,
  parseReport,
  replayEvents,
  reportedBodyKey,
  runView,
  statusOfEvent,
};

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
/**
 * Writes the state to `state.json`.
 *
 * The JSON file stays the SOURCE OF TRUTH. The SQLite metadata layer
 * (ATS-205) is a MIRROR of it: the same state is written into the
 * metadata database as queryable rows, so the history of the projects and
 * the runs can be queried without parsing the JSON.
 *
 * The mirror is best-effort on purpose: a bridge that cannot open the
 * metadata database still has to serve the API, so a failure of the mirror
 * is reported on stderr and the JSON file remains authoritative. It is
 * never the other way round -- the mirror can never break the bridge.
 */
export function saveState(v) {
  ensureData(); const file=path.join(dataDir(),'state.json'), tmp=file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(v,null,2),'utf8'); fs.renameSync(tmp,file);
  mirrorToSqlite(v);
}

/**
 * The metadata mirror is BEST-EFFORT, and a failure is not permanent.
 *
 * The JSON state file is the source of truth, so a failure of the mirror
 * must never take the bridge down -- but it must also never LOSE records.
 * The earlier revision of this module set a flag on the FIRST failure and
 * never wrote the mirror again for the lifetime of the process: one
 * transient failure (a concurrent writer holding the database lock, a full
 * disk, an antivirus scanner holding the file) silently dropped every
 * later project, run, attempt and artifact from SQLite. The mirror writes
 * the WHOLE state in one transaction, so a retry is self-healing: the next
 * successful write replaces the whole table set and the mirror catches up.
 *
 * The only failure that disables the mirror for good is
 * `SQLITE_NOT_AVAILABLE` -- the running Node build has no `node:sqlite`
 * at all, and no retry can change that.
 */

/** True when the Node build has no SQLite support at all: the mirror is off. */
let metaDbUnavailable = false;

/** The path of the metadata database inside the data directory. */
export const metadataPath = (dir = dataDir()) => path.join(dir, 'metadata.db');

/**
 * The busy timeout of the MIRROR connection, in milliseconds.
 *
 * The mirror runs SYNCHRONOUSLY on the bridge's event loop, so the wait
 * for a write lock has to be BOUNDED, and the bound has to be SHORT: a
 * mirror that waits for the layer's default 5000 ms blocks the event loop
 * for five seconds, and during those five seconds the bridge does not
 * answer a single request -- `GET /api/health` waited 5274 ms in the
 * measurement that motivated this value.
 *
 * The mirror therefore uses a SHORT timeout (1 second). When it expires
 * the mirror write is abandoned and the NEXT save tries again: the mirror
 * replaces the whole table set in one transaction, so a retry is
 * self-healing and the mirror catches up as soon as the obstruction is
 * gone. The state file is the truth and it is written before the mirror
 * runs, so nothing is lost by giving up on a write.
 *
 * §5.3 of the data design states this as the bound on how long a single
 * `saveState` can block the bridge.
 */
export const MIRROR_BUSY_TIMEOUT_MS = 1000;

/**
 * Writes the state into the metadata database.
 *
 * The database is opened for the write and closed again right after it.
 * The handle is deliberately NOT kept open: on Windows an open file
 * cannot be deleted, and a bridge that holds the metadata database open
 * would keep the data directory locked for every tool that tries to
 * clean it up. Opening a SQLite database is cheap, and the state is
 * written a handful of times per run.
 *
 * A failure is retried on the NEXT save: the write replaces the whole
 * table set, so the mirror heals itself as soon as the obstruction is
 * gone.
 *
 * @returns {boolean} true when the state was mirrored
 */
export function mirrorToSqlite(v) {
  if (metaDbUnavailable) return false;
  let db = null;
  try {
    db = openMetadataDatabase(metadataPath(), { busyTimeoutMs: MIRROR_BUSY_TIMEOUT_MS });
    storeState(db, v);
    return true;
  } catch (e) {
    // A mirror failure must not take the bridge down: the JSON state file
    // is the truth and it was written already.
    if (e?.code === 'SQLITE_NOT_AVAILABLE') {
      // The Node build has no SQLite at all. No retry can change that, so
      // the mirror stays off for the lifetime of the process.
      metaDbUnavailable = true;
    }
    console.error(`the SQLite metadata mirror failed: ${e.message}`);
    return false;
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
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
 // The static index is the HEURISTIC one: it sees the literal test()/it()
 // calls and nothing else. The authoritative index (`playwright test
 // --list`) sees the dynamic and parameterised cases too, but it EXECUTES
 // the project's code, so it only runs on a project the user has vouched
 // for. The warning therefore points at the way to get it, not at the raw
 // command.
 let warning='静态索引仅识别常见 test()/it() 形式；动态、参数化、fixture 测试不在其中。';
 if(ambiguous)warning+=` ${ambiguous} 个用例的 UID 为临时值（标题重复且无法唯一判定），需要用 @TC-xxx 显式标注或人工复核。`;
 if(duplicatedExplicit)warning+=` ${duplicatedExplicit} 个用例标注了同一个 @TC-xxx（重复的显式 UID），这些用例都没有绑定到该 UID，需要人工消歧。`;
 if(conflicts.length)warning+=` ${conflicts.length} 个用例的注册表记录与本次发现不一致（${[...new Set(conflicts.map(t=>t.ambiguity.reason))].join('、')}），其 UID 由本次发现派生，需要人工复核。`;
 return {files,tests,discovery:'static',uidVersion:UID_SCHEME_VERSION,projectUid,registry:resolved.registry,warning};
}

/**
 * The decision the TRUST and the REQUEST make together.
 *
 * The trust says whether the authoritative index is ALLOWED; the request
 * (`?authoritative=`) says whether it is WANTED. Three situations:
 *
 * | trust   | request          | index   | outcome              |
 * |---------|------------------|---------|----------------------|
 * | trusted | default / `true` | auth.   | the listing runs     |
 * | trusted | `false`          | static  | `NOT_REQUESTED`      |
 * | untrusted| default / `true`| static  | `SKIPPED_UNTRUSTED`  |
 *
 * The third row is the trust gate: a FORCE never overrides it.
 *
 * The second row used to be reported as `SKIPPED_UNTRUSTED` as well, which
 * told the user that a project they had vouched for was not vouched for.
 * The project IS trusted; the caller simply asked for the static index. The
 * two situations need different codes, because the user's next action is
 * different: one needs a vouch, the other needs no action at all.
 */
function decideDiscovery(trust, force) {
  const trusted = trust.trust === TRUST.TRUSTED;
  if (!trusted) {
    return { wantsAuthoritative: false, mode: 'untrusted', forced: force === true };
  }
  if (force === false) {
    return { wantsAuthoritative: false, mode: 'not-requested', forced: false };
  }
  return { wantsAuthoritative: true, mode: force === true ? 'forced' : 'default', forced: force === true };
}

/**
 * The static answer, with the reason the authoritative index was not used.
 *
 * The warning says what actually happened. A project that is not trusted
 * gets the trust gate; a TRUSTED project that asked for the static index
 * gets a plain note that the request was honoured -- it must not be told
 * that it is not trusted, because it is.
 *
 * The `fallback` mode is the third case: the listing was ALLOWED and it
 * FAILED. The project is trusted, so the trust gate does not apply and the
 * warning must not mention it -- the caller says what actually went wrong.
 */
function staticCatalog(project, registry, trust, decision) {
  const base = {
    ...discoverStatic(project, registry),
    trust,
    authoritative: {
      attempted: false,
      outcome: decision.mode === 'untrusted' ? 'SKIPPED_UNTRUSTED' : 'NOT_REQUESTED',
      reason: decision.mode === 'untrusted' ? trust.reason : ''
    }
  };
  if (decision.mode === 'not-requested') {
    return {
      ...base,
      discovery: DISCOVERY.STATIC,
      warning: `${base.warning} 已按请求使用静态索引（该项目已标记为可信，改用权威索引请去掉 authoritative 参数）。`
    };
  }
  if (decision.mode === 'fallback') {
    // The listing was allowed and it failed. The trust gate does not apply
    // here, so the warning must not talk about it.
    return { ...base, discovery: DISCOVERY.STATIC, warning: base.warning };
  }
  // The untrusted project never runs `--list`. The reason is part of the
  // answer -- and so is the way to get the authoritative index, which is
  // to vouch for the project (the decision is per project and revocable).
  //
  // The forced case (`?authoritative=true`) and the default case get the
  // SAME answer: the force says WHICH index to use, the trust says whether
  // it is ALLOWED to, and the trust wins.
  return {
    ...base,
    discovery: DISCOVERY.STATIC,
    warning: `${base.warning} 未可信仓库不可调用 --list（${trust.reason}），已使用静态索引；`
      + `把该仓库标记为可信（POST /api/projects/:id/trust {trust:"trusted"}）后即可使用权威索引。`
  };
}

/**
 * Discovers the test cases of a project: the STATIC index or the
 * AUTHORITATIVE one (`playwright test --list`), whichever the trust allows.
 *
 * WHY THE TRUST DECIDES
 * ---------------------
 * `playwright test --list` is NOT a read-only operation. It LOADS the project
 * config (executing the config's top level) and it EVALUATES the test files
 * (executing their top level) in order to collect the cases. Running it on a
 * repository therefore means RUNNING that repository's code -- the same trust
 * boundary as `playwright test` itself (ADR-005, docs/11-SECURITY-RISK.md).
 *
 * The difference is the TRIGGER. A run happens because the user asked for
 * it; an index is read whenever the catalogue is opened. An index that
 * silently executed code would turn "browse the catalogue" into "run the
 * repository's code", so the index only runs `--list` on a project the user
 * has vouched for.
 *
 * Therefore:
 *   * a TRUSTED project   -> the authoritative index (`discovery:
 *     'authoritative'`), which includes the dynamic and parameterised cases;
 *   * an UNTRUSTED project -> the STATIC index (`discovery: 'static'`), and
 *     the response says WHY the authoritative index was not used.
 *
 * The fallback is a fallback, not a failure: the user still gets an index,
 * and the index says plainly that it is the heuristic one.
 *
 * WHAT "与 CLI 发现结果一致" MEANS HERE
 * ------------------------------------
 * The agreement is MEASURED, not asserted: the two case lists are compared
 * case by case and the difference is reported in `consistency`. A case that
 * only the CLI knows is a dynamic case; a case that only the static scanner
 * knows is a case the CLI does not enumerate.
 *
 * THE TWO VARIANTS
 * -----------------
 * `discoverTests` runs the listing SYNCHRONOUSLY; `discoverTestsAsync` runs
 * it asynchronously. Both build the catalogue with the SAME code, so the
 * two answers differ in nothing but the timing.
 *
 * The Bridge uses the asynchronous one: the listing executes the project's
 * config, and a project whose config takes four seconds would otherwise
 * freeze the whole Bridge for those four seconds -- including the health
 * check and the stop button of a running test.
 */
export function discoverTests(project, state, registry, options = {}) {
  const trust = trustOf(state, project);
  const decision = decideDiscovery(trust, options.authoritative);
  if (!decision.wantsAuthoritative) {
    return staticCatalog(project, registry, trust, decision);
  }
  const listed = listTests(project, { timeoutMs: options.timeoutMs });
  return authoritativeCatalog(project, registry, trust, decision, listed);
}

/**
 * The asynchronous variant of `discoverTests`.
 *
 * The Bridge calls this one: the listing is a CHILD PROCESS that runs the
 * project's own code, and it may take a long time. Awaiting it keeps the
 * event loop free, so the Bridge keeps answering while a project is listed.
 */
export async function discoverTestsAsync(project, state, registry, options = {}) {
  const trust = trustOf(state, project);
  const decision = decideDiscovery(trust, options.authoritative);
  if (!decision.wantsAuthoritative) {
    return staticCatalog(project, registry, trust, decision);
  }
  const listed = await listTestsAsync(project, { timeoutMs: options.timeoutMs });
  return authoritativeCatalog(project, registry, trust, decision, listed);
}

/**
 * The authoritative answer: the catalogue of the CLI's own case list, with
 * the UIDs resolved and the agreement with the static index measured.
 */
function authoritativeCatalog(project, registry, trust, decision, listed) {
  if (!listed.ok) {
    const base = staticCatalog(project, registry, trust, { ...decision, mode: 'fallback', wantsAuthoritative: false });
    const detail = listed.errors && listed.errors.length ? ` — ${listed.errors[0].message}` : '';
    return {
      ...base,
      discovery: DISCOVERY.STATIC,
      authoritative: {
        attempted: true,
        outcome: listed.outcome,
        reason: listed.reason,
        errors: listed.errors || [],
        cli: listed.cli || null,
        version: listed.version || null
      },
      warning: `${base.warning} 权威发现失败（${listed.outcome}）：${listed.reason}${detail}，已回退到静态索引。`
    };
  }

  // The authoritative case list, with the UIDs resolved.
  const files = listed.files;
  const bodies = readBodies(project.root, files);
  const projectUid = projectUidOf(project);
  const projectRegistry = (registry && registry.projects && registry.projects[projectUid]) || { version: UID_SCHEME_VERSION, entries: [] };
  const resolved = resolveAuthoritativeIdentities({
    projectUid,
    cases: listed.tests,
    bodies,
    registry: projectRegistry,
    scope: new Set(files)
  });

  const tests = resolved.items.map(t => ({
    id: t.uid, uid: t.uid, uidSource: t.uidSource, uidStable: t.uidStable,
    uidBasis: t.basis,
    file: t.file, title: t.title, line: t.line,
    describePath: t.scope,
    specIds: t.specIds,
    source: 'authoritative', level: 'ST',
    ...(t.ambiguity ? { ambiguity: t.ambiguity } : {})
  }));

  const consistency = compareDiscoveries(listed.tests, staticCasesWithScope(project.root, files));
  const ambiguous = tests.filter(t => !t.uidStable).length;
  const duplicatedExplicit = tests.filter(t => t.ambiguity?.reason === 'duplicate-explicit-uid').length;
  const outside = (listed.skipped && listed.skipped.length) || 0;

  let warning = `权威索引来自 playwright test --list（CLI ${listed.version || '?'}）：动态与参数化用例已包含在内。`;
  if (ambiguous) warning += ` ${ambiguous} 个用例的 UID 为临时值（标题与 describe 路径都无法唯一判定），需要用 @TC-xxx 显式标注或人工复核。`;
  if (duplicatedExplicit) warning += ` ${duplicatedExplicit} 个用例标注了同一个 @TC-xxx，这些用例都没有绑定到该 UID，需要人工消歧。`;
  if (outside) warning += ` ${outside} 个用例位于项目根目录之外，已被排除。`;
  if (!consistency.agrees) warning += ` 与静态索引的差异：${consistency.onlyAuthoritative.length} 个用例仅权威索引可见，${consistency.onlyStatic.length} 个用例仅静态索引可见。`;

  return {
    files,
    tests,
    discovery: DISCOVERY.AUTHORITATIVE,
    uidVersion: resolved.registry.version,
    projectUid,
    registry: { version: resolved.registry.version, projects: { ...((registry && registry.projects) || {}), [projectUid]: resolved.registry } },
    warning,
    trust,
    authoritative: {
      attempted: true,
      outcome: LIST_OUTCOME.OK,
      reason: '',
      cli: listed.cli,
      version: listed.version,
      rootDir: listed.rootDir,
      durationMs: listed.durationMs,
      specCount: listed.tests.length
    },
    consistency
  };
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
 * ATS-208: the parsing, the aggregation and the status vocabulary moved to
 * `server/execution/model.mjs`, which is the ONE place the execution model
 * is defined. This function is re-exported from there (see the imports at
 * the top of this file) and kept here so that the existing callers keep
 * working.
 *
 * The two levels of status are kept apart, because they answer different
 * questions:
 *
 *   * `status` -- the CASE level status (`passed` / `failed` / `flaky` /
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

/**
 * Builds the Attempt records of one Run.
 *
 * ATS-208: moved to `server/execution/model.mjs` and re-exported here.
 */
export function compactLog(log){return log.length>150000?log.slice(-150000):log;}
