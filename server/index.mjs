import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState,saveState,validateProjectPath,gitInfo,discoverStatic,discoverTests,discoverTestsAsync,readSource,writeSource,safeRunArgs,runDir,filesInRun,artifactPath,parseReport,now,safeId,compactLog,attemptsForRun,acquireBridgeLock,releaseBridgeLock,lockPath,verifyBridgeLock,lockWaitFromEnv,lockVerifyIntervalFromEnv,removeStateTempFiles,recoverMetadataMirror,dataDir } from './core.mjs';
import { projectUidFor, projectUidOf, runUidFor, attemptUidFor, nextRunSeq, UID_SCHEME_VERSION } from './uid.mjs';
// ATS-208: the unified execution model. The event vocabulary, the state
// machine and the replay live in `server/execution/model.mjs`; the bridge
// only WRITES the events and READS them back.
import { EVENT_TYPE, RUN_STATUS, isAllowedTransition, isTerminalRunStatus, nextEventSeq, parseEventLog, replayEvents } from './execution/model.mjs';
import { trustOf, withTrust } from './discovery/trust.mjs';
import { AGENT_CONTRACT_VERSION,describeAgentContract,validateAgentRequest } from './agent.mjs';
import { PLUGIN_CONTRACT_VERSION,describePluginContract,validatePluginManifest,resolvePluginPermissions } from './plugins/contract.mjs';
import { capabilityMatrix,getAdapter,listRunners,selectAdapter,selectAdapterOrThrow , negotiationFailure} from './adapters/registry.mjs';
import { AdapterError } from './adapters/contract.mjs';
// ATS-402: the AI data security surface. The credential store keeps only
// REFERENCES on disk -- the secret itself lives in the OS credential store.
// The egress consent store keeps the informed-consent records; no egress
// happens without a granted consent whose scope still matches the content
// about to be sent.
import { createCredentialStore,credentialIndexPath,describeCredentialStore } from './security/credentials.mjs';
import { createEgressConsentStore,describeEgressConsent,describeEgressScope } from './security/egress-consent.mjs';
import { authorizeEgress,buildEgressScope,describeRequestedRefs } from './security/egress-gate.mjs';
import { createEgressAuditStore,describeEgressAudit } from './security/egress-audit.mjs';
// ATS-212: the environment profiles. A profile is a named, project-scoped
// set of environment variables; the run carries the profile it ran under
// and the runner receives the SEALED environment (the profile's variables
// plus the platform base keys -- never the host's own environment).
import { ENVIRONMENTS, buildRunnerEnv, envVarNames, filterProfileVariables } from './env/profiles.mjs';
import {
  envStoreOf, profilesOfProject, findProfile, whitelistForProject,
  upsertProfile, removeProfile, setWhitelist, publicProfile, projectKeyOf,
} from './env/store.mjs';
// ATS-209: the evidence manifest, the content-addressed store and the
// retention cleaner. The manifest is written when a run ends, the
// verification answers whether the archived evidence still matches it, and
// the retention policy decides which evidence may be cleaned -- and the
// cleaner never touches the run records.
import {
  DEFAULT_RETENTION_DAYS, buildManifest, verifyEvidence,
} from './evidence/manifest.mjs';
import {
  planRetention,
} from './evidence/retention.mjs';
import {
  deduplicationReport, evidenceIndexOf, indexRunEvidence,
} from './evidence/dedup.mjs';
import {
  linkToBlob, storeBlob, storeBytes, storeDirOf,
} from './evidence/store.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,'..');
const PORT=Number(process.env.ATS_PORT||4577);
const TOKEN=crypto.randomBytes(24).toString('hex');
const jobs=new Map();
// The data directory is locked for the whole lifetime of the Bridge. The
// migration script (tools/migrate_uids.mjs) rewrites the state file AND
// renames the run folders; a Bridge that is running at that moment would
// overwrite the migrated state with its own in-memory copy on the next
// save, and the state would point at run folders that no longer exist.
// ATS-207: the acquisition is ATOMIC -- of two Bridges that start at the
// same instant exactly one gets the lock -- and a starting Bridge may WAIT
// for a busy lock (ATS_LOCK_WAIT_MS, default 0: refuse at once).
const lockWaitMs=lockWaitFromEnv(process.env.ATS_LOCK_WAIT_MS);
try{acquireBridgeLock(lockPath(),{waitMs:lockWaitMs});}
catch(e){
  if(e.code!=='BRIDGE_ALREADY_RUNNING'){
    console.error(`the data directory lock (${lockPath()}) could not be taken: ${e.message}`);
    process.exit(1);
  }
  // The lock is held by a process that is still running. The holder may be a
  // Bridge that is working, or a leftover file whose pid was reused -- the
  // lock file alone cannot tell the two apart, so the answer states both the
  // check and the recovery step instead of guessing.
  const holderPid=e.holder?.pid ?? '<pid>';
  console.error(
    `another process holds the data directory lock (${lockPath()}): ${e.message}
` +
    `holder: pid ${holderPid}, started ${e.holder?.processStartedAt ?? e.holder?.startedAt ?? 'unknown'}` +
    (lockWaitMs>0 ? ` (waited ${e.waitedMs} ms)` : '') + `
` +
    `Only one Bridge can use a data directory at a time. To recover:
` +
    `  1. check whether that process is a Bridge: tasklist /FI "PID eq ${holderPid}"
` +
    `  2. if no Bridge is running, delete the lock file and start the Bridge again:
` +
    `     del "${lockPath()}"
` +
    `Deleting the lock file is safe only after step 1 confirms that no Bridge is running.`
  );
  process.exit(1);
}
process.on('exit',()=>releaseBridgeLock());
// ATS-207: a state file that exists but cannot be read is NEVER replaced by
// the empty state -- that would discard every project and the whole run
// history on the first save. The Bridge refuses to start, and leaves the
// state file, the temp files and the mirror exactly as they are.
let store;
try{store=loadState();}
catch(e){
  if(e.code!=='STATE_CORRUPT'&&e.code!=='UNSUPPORTED_DATABASE')throw e;
  console.error(
    `the state file cannot be read (${e.code}): ${e.file}: ${e.detail}
` +
    `The Bridge does not start: starting would replace the project and run history with an empty state.
` +
    `To recover:
` +
    `  1. keep a copy of the damaged file: copy "${e.file}" "${e.file}.damaged"
` +
    `  2. restore the last good copy -- the migration backup "${e.file}.bak" when it exists (docs/24-STATE-MIGRATION.md) --
` +
    `     or move the damaged file away to start with an empty state.`
  );
  process.exit(1);
}
// ATS-207: the temp files of a save that did not complete (the rename is the
// commit point) are removed; this process holds the lock, so they cannot
// belong to a live writer.
const strayTemps=removeStateTempFiles();
if(strayTemps.length)console.error(`removed the temp files of an interrupted save: ${strayTemps.join(', ')}`);
// ATS-207: opening the mirror replays its WAL (SQLite's own crash recovery);
// a mirror that is DAMAGED is moved aside and the first save below rebuilds
// it from the state file.
{
  const mirror=recoverMetadataMirror();
  if(mirror.status==='quarantined')console.error(`the SQLite metadata mirror was damaged and has been quarantined (${mirror.reason}); moved: ${mirror.moved.join(', ')}; it is rebuilt from state.json`);
  else if(mirror.status==='quarantine-failed'||mirror.status==='unchecked')console.error(`the SQLite metadata mirror could not be checked (${mirror.status}): ${mirror.reason}`);
}
// ATS-208: the events of a run travel with the run record, and the durable
// `events.jsonl` of its own folder is the RECORD of what happened.
//
// The two are reconciled on EVERY start, not only for the runs that were
// written before ATS-208. The reason is a crash window: an event is written
// to `events.jsonl` first and the state is saved afterwards, so a bridge
// that dies in between leaves the log one event AHEAD of the state file.
// The counter of the run would then hand out a sequence number that the log
// already holds -- two events with the same number, and the metadata layer's
// primary key (run_uid, seq) would refuse the duplicate.
//
// So the log is the authority: the events of the run are read back from it,
// and the state's own copy is reconciled against it. An event that the log
// does not have (the bridge died between the state write and the log
// write -- impossible in that order, but possible if the log was truncated)
// is dropped rather than kept, because the log is what a reader replays.
//
// A DAMAGED LOG MUST NOT TAKE THE BRIDGE DOWN. The log of a run can be
// missing (the folder was deleted), unreadable (permissions) or TORN (a
// crash in the middle of an append left a fragment of JSON at the end).
// Every one of those used to throw, and the bridge refused to start: one
// damaged run blocked the whole installation. The recovery path now
// degrades: the problem is recorded on the run, the run is still recovered
// into a terminal state, and the bridge starts.
const recoveryProblems=[];
/**
 * True when the status is one a run never leaves.
 *
 * The set lives in the model (`TERMINAL_RUN_STATUS`), and the bridge asks
 * the model -- the vocabulary is defined in ONE place.
 *
 * It is declared HERE, before the recovery block, because the recovery runs
 * at module load time -- a `const` declared further down would not be
 * initialised yet.
 */
const isTerminalStatus=(status)=>isTerminalRunStatus(status);
for(const run of store.runs){
 const file=path.join(runDir(run.id),'events.jsonl');
 let logged=[];
 let unreadable=[];
 try{
  if(!fs.existsSync(file)){
   // The run folder is gone. The events of that run cannot be read, but
   // the run itself can still be recovered: it is the RUN that is
   // interrupted, not the bridge.
   if(['queued','running','cancelling'].includes(run.status))
    recoveryProblems.push(`run ${run.id}: the run folder is missing (${file})`);
   continue;
  }
  const parsed=parseEventLog(fs.readFileSync(file,'utf8'));
  logged=parsed.events;unreadable=parsed.unreadable;
 }catch(e){
  recoveryProblems.push(`run ${run.id}: the event log could not be read (${e.message})`);
  continue;
 }
 if(unreadable.length)
  recoveryProblems.push(`run ${run.id}: ${unreadable.length} line(s) of the event log could not be parsed: ${unreadable.join(', ')}`);
 if(!logged.length)continue;
 // The events of the state that the log does not have are dropped: the log
 // is the record, and a reader replays the log.
 run.events=logged;
 // The counter of the run must agree with the events that were read back,
 // otherwise the next event would reuse a number that is already taken.
 const highest=run.events.reduce((max,e)=>Math.max(max,Number(e.seq)||0),0);
 if(highest>run.eventSeq)run.eventSeq=highest;
}
// ATS-208: the recovery of a run whose bridge died. The run is marked
// `interrupted` AND the event that says so is written -- without the event
// the events of an interrupted run determined no status at all, so they
// could not be replayed. The event is written BEFORE the status changes,
// because the state machine allows `run.interrupted` from the status the
// run was in, not from the status it is given.
//
// THE RECOVERY IS DRIVEN BY THE LOG, NOT BY THE STATE FILE.
//
// The state file and the log can disagree: an event is appended to the log
// first and the state is saved afterwards, so a bridge that dies in
// between leaves the log AHEAD of the state. In that window the log
// already says the run FINISHED, while the state still says `running`.
//
// Two rules follow, and both are required:
//
//   1. NO EVENT IS APPENDED AFTER A TERMINAL EVENT. A stream that says
//      `run.finished` and then `run.interrupted` describes a run that
//      never existed -- and the replay would have to report a violation.
//      When the log already holds a terminal event, the recovery adopts
//      that terminal status instead of appending anything.
//   2. THE STATUS COMES FROM THE REPLAY OF THE LOG. The log is the record;
//      the state file is a cache of it.
//
// `cancelling` is part of the recovery set: a run whose bridge died while
// the engine was being terminated is exactly as interrupted as one whose
// engine was still running, and leaving it in `cancelling` would keep the
// project locked for ever (the run never reaches a terminal state, and
// `POST /stop` cannot release it because there is no job any more).
for(const run of store.runs){
 // The status the LOG says the run ended in, if the log says so.
 const logged=replayEvents(run.events??[]);
 if(logged.status!==null&&isTerminalStatus(logged.status)){
  // The log already names a terminal status. That status is adopted --
  // NOTHING is appended, so the stream stays a valid description of a run.
  if(run.status!==logged.status){
   run.status=logged.status;
   run.finishedAt=run.finishedAt||now();
   if(logged.status===RUN_STATUS.INTERRUPTED&&!run.error)run.error='Server restarted while run was active';
   // The run may have died BEFORE its results were collected (the crash
   // window between the event write and the state write). The results are
   // collected now, so the adopted terminal status is not a claim without
   // evidence. When they cannot be collected the run SAYS SO.
   if(!run.summary){
    try{collectRunResults(run);}
    catch(e){run.reportWarning=`the results of the recovered run could not be collected (${e.message})`;}
   }
  }
  continue;
 }
 if(['queued','running','cancelling'].includes(run.status)){
  writeEvent(run,EVENT_TYPE.INTERRUPTED,{reason:'Server restarted while run was active'});
  run.status=RUN_STATUS.INTERRUPTED;run.finishedAt=now();run.error='Server restarted while run was active';
 }
}
for(const problem of recoveryProblems)console.error(`the recovery of a run was degraded: ${problem}`);
saveState(store);
// ATS-207: the holder check. The Bridge holds the lock for its whole
// lifetime, and it CHECKS that it still does: a lock that was deleted is
// taken again; a lock that now belongs to another process means two Bridges
// would share the data directory, so this one stops.
let lockUnreadable=false;
setInterval(()=>{
  const state=verifyBridgeLock();
  if(state.held){lockUnreadable=false;return;}
  if(state.reason==='unreadable'){
    // A transient read failure is checked again on the next tick; a garbage
    // file that stays is taken over by the next starter, and then reported as
    // taken-over.
    if(!lockUnreadable)console.error(`the data directory lock (${lockPath()}) could not be read; checking again`);
    lockUnreadable=true;return;
  }
  if(state.reason==='absent'){
    try{acquireBridgeLock(lockPath(),{createDir:false});console.error(`the data directory lock (${lockPath()}) was deleted while the Bridge was running; re-acquired`);return;}
    catch(e){console.error(`lost the data directory lock (${lockPath()}): it was deleted and could not be taken again (${e.message}); the Bridge stops`);process.exit(1);}
  }
  console.error(`lost the data directory lock (${lockPath()}): it now belongs to pid ${state.holder?.pid ?? 'unknown'}; the Bridge stops so that two Bridges never share one data directory`);
  process.exit(1);
},lockVerifyIntervalFromEnv(process.env.ATS_LOCK_VERIFY_MS)).unref();

// --- ATS-402: the credential store and the egress consent store -----------
// The credential store holds ONLY references in `credentials.json`; the
// secrets themselves live in the OS credential store. The consent records
// live in state.json, so they share the same atomic write as the rest of
// the platform state.
const credentialStore=createCredentialStore({indexFile:credentialIndexPath(dataDir())});
const egressConsentStore=createEgressConsentStore({
  list:async()=>store.egressConsents??[],
  persist:async(records)=>{store.egressConsents=records;saveState(store);},
});
// ATS-402: the egress audit trail. Every egress decision -- allowed OR denied
// -- leaves a record, so "the platform refused it" is a fact somebody can
// check rather than a claim. The records hold refs and digests, never content.
const egressAuditStore=createEgressAuditStore({
  list:async()=>store.egressAudit??[],
  persist:async(records)=>{store.egressAudit=records;saveState(store);},
});

/**
 * 解析一次外传的范围：**由平台侧读真实文件并复算摘要**。
 *
 * 这是 ATS-401 契约层留下的缺口的落点（`docs/17-AGENT-CONTRACT.md` §6）：
 * 契约层的 `digest` 由请求方提供，只能证明「二者自洽」；这里的摘要由
 * 本机文件系统给出，于是「`ref` 确实对应那份源内容」才成立。
 */
function egressRunResolver(ref){
  const run=getRun(ref);
  const content=JSON.stringify({runId:run.id,status:run.status,summary:run.summary??null});
  return {kind:'run',ref,digest:crypto.createHash('sha256').update(content,'utf8').digest('hex'),content};
}
// preview, confirm and check ALL resolve the scope through this one function.
function buildScope(project,inputs){
  return buildEgressScope({project,inputs,runResolver:egressRunResolver});
}

const ORIGINS=new Set([`http://localhost:${PORT}`,`http://127.0.0.1:${PORT}`,'http://localhost:3000','http://127.0.0.1:3000','tauri://localhost','http://tauri.localhost','https://tauri.localhost']);
// ATS-216: the `.mjs` type is here because the portable UI imports the shared quality module (`apps/studio/public/quality.mjs`) as an ES module; a browser refuses to execute a module served with a non-JavaScript MIME type.
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.zip':'application/zip','.txt':'text/plain; charset=utf-8','.map':'application/json'};
const respond=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
const err=(res,status,msg,extra)=>respond(res,status,extra?{error:msg,...extra}:{error:msg});
/**
 * The events of a run, read from its durable log.
 *
 * The log may be MISSING (the run folder was deleted) or TORN (a crash in
 * the middle of an append left a fragment of JSON at the end). Neither is
 * a reason to answer with a 500: the reader gets the events that ARE
 * readable, plus a report of what was not.
 *
 * @returns {{events:object[],unreadable:number[],missing:boolean,truncated:boolean}}
 */
function readRunEvents(id){
 const file=path.join(runDir(id),'events.jsonl');
 if(!fs.existsSync(file))return {events:[],unreadable:[],missing:true,truncated:false};
 try{
  const parsed=parseEventLog(fs.readFileSync(file,'utf8'));
  return {...parsed,missing:false};
 }catch(e){
  // The file exists but cannot be read (permissions, a directory in the
  // way). The run is still readable through its state record.
  console.error(`the event log of run ${id} could not be read (${e.message})`);
  return {events:[],unreadable:[],missing:false,truncated:false};
 }
}
async function body(req){let buf='';for await(const chunk of req){buf+=chunk;if(buf.length>1_200_000)throw new Error('PAYLOAD_TOO_LARGE');}return buf?JSON.parse(buf):{};}
function getProject(id){const p=store.projects.find(p=>p.id===id||p.uid===id);if(!p)throw new Error('PROJECT_NOT_FOUND');return p;}
function getRun(id){const r=store.runs.find(r=>r.id===id||r.uid===id);if(!r)throw new Error('RUN_NOT_FOUND');return r;}
function cleanProject(p){let git={branch:'-',commit:'-',dirty:false};try{git=gitInfo(p.root);}catch{} return {...p,uid:p.uid||projectUidOf(p),git};}
/**
 * Writes one event of a run.
 *
 * ATS-208: the event stream is the AUDIT TRAIL of the run, and it has to
 * satisfy three properties:
 *
 *   1. it is APPEND-ONLY -- an event is never rewritten;
 *   2. its SEQUENCE is gap-free and strictly increasing -- the numbers of a
 *      run's events are 1..N with no hole, so a reader can tell "the run
 *      reached event 7" from "event 7 was lost";
 *   3. it REPLAYS -- folding the events in their sequence order yields the
 *      state the run is in.
 *
 * The event is written to BOTH places it has to be in:
 *
 *   * `events.jsonl` -- the durable, append-only log of the run folder;
 *   * `run.events`    -- the state file, so that the events travel with the
 *     run record and the SQLite mirror can index them.
 *
 * The two are written from the SAME event object, so they cannot disagree.
 *
 * An event that the state machine does not allow from the current status is
 * REFUSED: it is reported on stderr and NOT written. A stream that
 * contradicts the state machine would make the replay meaningless, and a
 * silent contradiction is worse than a loud one.
 *
 * THE WRITER REPAIRS A TORN LOG. A crash in the middle of an append leaves
 * the last line of `events.jsonl` without its newline and half written. The
 * next append would then be glued onto that fragment, and the result would
 * be unreadable for ever. So the writer checks whether the file ends with a
 * newline and adds one before appending.
 */
function writeEvent(run,type,data={}){
 if(!isAllowedTransition(run.status,type)){
  console.error(`the event ${type} is not allowed from the status ${run.status} of run ${run.id} -- it was refused`);
  return null;
 }
 const ev={seq:nextEventSeq(run),at:now(),type,data};
 // The counter of the run is advanced FIRST, so the next event takes the
 // next number even when the write below fails.
 run.eventSeq=ev.seq;
 run.events=run.events??[];
 run.events.push(ev);
 const file=path.join(runDir(run.id),'events.jsonl');
 try{
  // The folder of the run may be gone (deleted by the user, or by a
  // cleaner). The event still goes into the state, so the run keeps a
  // coherent history; the LOG is repaired below when it comes back.
  fs.mkdirSync(path.dirname(file),{recursive:true});
  // Repair a torn tail: a file that does not end with a newline would glue
  // the next event onto the fragment of the previous one.
  let prefix='';
  try{
   const stat=fs.statSync(file);
   if(stat.size>0){
    const tail=fs.readFileSync(file,'utf8').slice(-1);
    if(tail!=='\n')prefix='\n';
   }
  }catch{/* the file does not exist yet: nothing to repair */}
  fs.appendFileSync(file,prefix+JSON.stringify(ev)+'\n');
 }catch(e){
  console.error(`the event ${type} of run ${run.id} could not be written to the durable log (${e.message})`);
 }
 return ev;
}
/**
 * Collects the results of a finished run.
 *
 * The RAW Playwright report is parsed separately from the adapter's
 * summary: the adapter maps the engine's vocabulary onto the common result
 * model, but the Attempt records need the per-retry details (line, retry
 * index and the RESULT level status) that only the raw report carries.
 *
 * It is used in TWO places:
 *
 *   * when the engine exits (`finishRun`);
 *   * when the RECOVERY adopts a terminal status that the durable log
 *     already names -- a run that died between the event write and the
 *     state write has no summary, and the run would claim to have passed
 *     without saying a single word about its cases. The results are
 *     collected again from the run folder, and when even that is not
 *     possible the run says so explicitly instead of pretending it has no
 *     cases.
 */
function collectRunResults(run){
 const folder=runDir(run.id);
 const adapter=run.runner?getAdapter(run.runner):null;
 let rawSummary=null;
 const reportFile=path.join(folder,'report.json');
 if(fs.existsSync(reportFile)){try{rawSummary=parseReport(JSON.parse(fs.readFileSync(reportFile,'utf8')));}catch(e){run.reportWarning=String(e.message);}}
 if(adapter){try{const collected=adapter.collect({outputDir:folder});if(collected&&collected.summary)run.summary=collected.summary;}catch(e){run.reportWarning=String(e.message);}}
 if(!run.summary)run.summary=rawSummary;
 if(!run.summary){
  // The results could not be collected at all. The run says so: a summary
  // of zeros would be indistinguishable from a run that really had no
  // cases, and the reader would draw the wrong conclusion.
  run.summary={passed:0,failed:0,skipped:0,flaky:0,total:0,executions:0,cases:[]};
  run.summaryCollected=false;
  run.reportWarning=run.reportWarning||'the results of the run were not collected: the run ended before the report was read';
 }else{
  run.summaryCollected=true;
 }
 // The report names the test files relative to the Playwright rootDir, the
 // registry stores them relative to the project root. The project root is
 // needed to reconcile the two spellings.
 const proj=store.projects.find(p=>p.id===run.projectId||p.uid===run.projectId||p.uid===run.projectUid);
 run.attempts=attemptsForRun({...run,projectRoot:proj?.root??null},rawSummary??run.summary,store.uidRegistry);
 // ATS-209: the artifacts are the EVIDENCE of the run. The event log and
  // the raw output are the run's RECORD, and the manifest is the record OF
  // the evidence -- so neither of them is an artifact. Keeping the three
  // apart is what lets the cleaner remove the evidence while the record
  // and the manifest survive.
  //
  // The collector is the SAME one the manifest uses, so the run record and
  // the manifest describe the same set of files (ATS-209 review round 1,
  // E6). It already leaves out the run's record, the manifest itself and
  // the cleaner's own record.
  run.artifacts=filesInRun(run.id);
 }
function finishRun(run,code,signal){
 if(run.status!=='running'&&run.status!=='cancelling')return;
 const cancelled=run.status==='cancelling';
 // ATS-208: the `run.finished` event is written BEFORE the status changes,
 // so the event names the status the run ended in. That is what lets the
 // replay of the event stream yield the same status the run record carries.
 const terminalStatus=cancelled?'cancelled':code===0?'passed':'failed';
 writeEvent(run,EVENT_TYPE.FINISHED,{status:terminalStatus,code,signal});
 run.status=terminalStatus;run.exitCode=code;run.finishedAt=now();
 const folder=runDir(run.id);
 collectRunResults(run);
 // ATS-209: the MANIFEST is the archive's own record of what it holds.
 //
 // It is built from the run record and the folder's CONTENTS, so the same
 // run and the same files always produce the same manifest -- which is
 // what makes it verifiable. The v0.1 manifest was a literal with
 // `version:1` and no evidence section: it listed the artifacts, but it
 // did not say WHICH RUN the digests belonged to, and it carried no
 // digest of the evidence set as a whole.
 const manifest=buildManifest(run,folder,{artifacts:run.artifacts});
 // ATS-212: the manifest names the environment profile the run ran under
 // and the NAMES of the variables it carried -- never their values. The
 // manifest is archived with the evidence, so a value does not travel with
 // it; the names say WHICH configuration was in effect.
 if(run.envUid)manifest.env={uid:run.envUid,name:run.envName||null,tier:run.envTier||null,variables:run.envVariables||[]};
 fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2));
 // ATS-209: the DEDUPLICATION index. The evidence of this run is recorded
 // in the index, so the second run that produces the same bytes is
 // recognised as a duplicate of the first.
 const index=evidenceIndexOf(store);
 indexRunEvidence(index,run,run.artifacts);
 // ATS-209: the CONTENT-ADDRESSED STORE. The bytes of every evidence file
 // are stored once, under their own digest, and the run's file becomes a
 // hard link to the stored copy. The file is replaced ATOMICALLY (the link
 // is created under a temporary name and renamed over the target), so a
 // reader never sees a half-installed file.
 //
 // A file that cannot be stored or linked (a different volume, a file
 // system without links, a file above the size limit) is left alone: the
 // evidence is still archived and still verifiable, it is simply not
 // deduplicated. The reason is recorded on the run rather than swallowed.
 const storeDir=storeDirOf(dataDir());
 const dedup={stored:0,linked:0,refused:[]};
 for(const artifact of run.artifacts??[]){
  const full=path.join(folder,artifact.file);
  const stored=storeBlob(storeDir,full,artifact.sha256);
  if(!stored.stored){if(stored.reason)dedup.refused.push({file:artifact.file,reason:stored.reason});continue;}
  dedup.stored+=1;
  const linked=linkToBlob(full,stored.path);
  if(linked.linked)dedup.linked+=1;
  else dedup.refused.push({file:artifact.file,reason:linked.reason});
 }
 if(dedup.refused.length)run.dedupRefused=dedup.refused;
 run.evidence=manifest.evidence;
 jobs.delete(run.id);saveState(store);
}
 function startRun(project,run,adapter,envProfile,envVariables){
   const folder=runDir(run.id);fs.mkdirSync(folder,{recursive:true});
   // ATS-208: the events are written BEFORE the status changes, so each
   // event records the status the run is leaving and the stream replays.
   writeEvent(run,EVENT_TYPE.QUEUED,{file:run.file,runner:run.runner});
   let handle;
   // ATS-212: the SEALED environment of the child process.
   //
   // It is the profile's own variables plus the platform base keys -- NOT
   // the host's environment. Nothing the operator had in their shell (their
   // cloud credentials, their CI tokens) reaches the code under test and
   // can be printed into a report that is archived as evidence.
   //
   // With no profile the environment is still SEALED: the base keys and
   // nothing else. The host's variables do not reach the runner either way.
   //
   // The variables are the ones the CURRENT WHITELIST permits and the
   // CURRENT reserved list allows (the caller filtered them); the profile
   // itself may still carry more.
   const sealedEnv=buildRunnerEnv({variables:envVariables??envProfile?.variables??{}});
   try{handle=adapter.start({project,run,file:run.file,outputDir:folder,env:sealedEnv});}
  catch(e){
   writeEvent(run,EVENT_TYPE.ERROR,{error:e.message});
   run.status=RUN_STATUS.ERROR;run.error=e.message;run.finishedAt=now();saveState(store);return;
  }
  const cp=handle.child;
  writeEvent(run,EVENT_TYPE.STARTED,{pid:cp.pid,runner:run.runner});
  run.status=RUN_STATUS.RUNNING;run.pid=cp.pid;run.startedAt=now();run.command=[handle.command,...handle.args];jobs.set(run.id,{child:cp,handle});saveState(store);
  for(const stream of [cp.stdout,cp.stderr])stream.on('data',buf=>{
   const str=buf.toString('utf8');run.log=compactLog((run.log||'')+str);
   fs.appendFileSync(path.join(folder,'stdout.log'),str);
  });
  cp.on('error',e=>{run.error=e.message;finishRun(run,127,'spawn-error');});
  cp.on('close',(code,signal)=>finishRun(run,code,signal));
 }
 function cancelRun(run){
  const job=jobs.get(run.id);
  // A run that is ALREADY terminal cannot be stopped: it is over. The old
  // code answered RUN_NOT_ACTIVE for every run without a live job, which
  // covered two very different situations:
  //
  //   * the run is finished -- the caller asked too late;
  //   * the run is stuck in `cancelling` after the bridge died -- the caller
  //     asked to release a run that can never finish.
  //
  // The second one is the case that matters: a run in `cancelling` whose
  // bridge died has no job, and it holds the project's run lock for ever.
  // Stopping it must RELEASE it, not fail.
  if(!job){
   if(isTerminalStatus(run.status))throw new Error('RUN_NOT_ACTIVE');
   // The run is in flight but the bridge that owned it is gone (or the job
   // was never registered). The honest answer: the run is interrupted and
   // it is released.
   if(['queued','running','cancelling'].includes(run.status)){
    writeEvent(run,EVENT_TYPE.INTERRUPTED,{reason:'the run was stopped without a live engine'});
    run.status=RUN_STATUS.INTERRUPTED;run.finishedAt=now();run.error=run.error||'the run was stopped without a live engine';
    saveState(store);
   }
   return;
  }
  writeEvent(run,EVENT_TYPE.CANCELLING);
  run.status=RUN_STATUS.CANCELLING;saveState(store);
  const cp=job.child;
  if(process.platform==='win32')spawn('taskkill',['/PID',String(cp.pid),'/T','/F'],{windowsHide:true});
  else {try{cp.kill('SIGTERM');}catch{}}
 }
function checkedRequest(req){
 const host=req.headers.host||'';if(!new RegExp(`^(localhost|127\\.0\\.0\\.1):${PORT}$`,'i').test(host))return 'INVALID_HOST';
 const origin=req.headers.origin;
 if(origin&&!ORIGINS.has(origin))return 'ORIGIN_NOT_ALLOWED';
 return null;
}
function staticFile(req,res,pathname){
 const roots=[path.join(ROOT,'apps/studio/out'),path.join(ROOT,'apps/studio/public')];
 let found=null;
 for(const r of roots){const candidate=path.resolve(r,'.'+(pathname==='/'?'/index.html':pathname));if(!candidate.startsWith(r+path.sep))continue;
 if(fs.existsSync(candidate)&&fs.statSync(candidate).isFile()){found=candidate;break;}}
 if(!found){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('UI not built. Run npm --prefix apps/studio install && npm run build:web. A standalone fallback is available at /fallback.html');return;}
 res.writeHead(200,{'Content-Type':mime[path.extname(found)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:4577 http://localhost:4577"});fs.createReadStream(found).pipe(res);
}
const server=http.createServer(async(req,res)=>{
 const bad=checkedRequest(req);if(bad)return err(res,403,bad);
 const origin=req.headers.origin;if(origin&&ORIGINS.has(origin)){
 // ATS-212: `DELETE` is one of the methods the environment routes use
 // (`DELETE /api/projects/<id>/env`), so it has to be in the allowed
 // methods -- a cross-origin client (the Tauri shell, the Next dev server)
 // could not delete a profile without it.
 //
 // `Access-Control-Allow-Origin` names the requesting origin back to the
 // browser. Without it the browser blocks EVERY cross-origin response, so a
 // whitelisted client (the Next dev server on 3000, the Tauri shell) could
 // not read any API answer even though the origin passed the whitelist.
 res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, DELETE, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-ATS-Token');res.setHeader('Vary','Origin');}
 if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
 const u=new URL(req.url,`http://127.0.0.1:${PORT}`),p=u.pathname;
 if(p==='/api/health')return respond(res,200,{ok:true,version:'0.1.0',mode:'local',node:process.version});
 if(p==='/api/session'&&req.method==='GET')return respond(res,200,{token:TOKEN,mode:'local'});
 if(p.startsWith('/api/')&&req.headers['x-ats-token']!==TOKEN)return err(res,401,'INVALID_SESSION');
 try{
 if(p==='/api/projects'&&req.method==='GET')return respond(res,200,{projects:store.projects.map(cleanProject)});
 if(p==='/api/projects'&&req.method==='POST'){
  const b=await body(req);const actual=validateProjectPath(b.path);
  // The project identifier is the stable UID: it is derived from the
  // canonical project root, so re-registering the same repository yields the
  // same identifier and the project can be referenced from outside the
  // local state file.
  const uid=projectUidFor(actual);
  // The duplicate check uses the SAME normalisation as the UID: `realpath`
  // keeps the case of the path it was given, so on a case insensitive
  // filesystem `D:\Proj` and `D:\proj` are the same directory but two
  // different strings. Comparing the raw `root` strings would register the
  // same repository twice under ONE id -- two records, one identifier.
  // The UID is the normalised comparison, so it is the right key here.
  const existing=store.projects.find(x=>x.id===uid||x.uid===uid||projectUidOf(x)===uid);
  if(existing)throw new Error('PROJECT_ALREADY_REGISTERED');
  const project={id:uid,uid,name:path.basename(actual),root:actual,addedAt:now()};
  store.projects.push(project);saveState(store);return respond(res,201,{project:cleanProject(project)});
 }
 const pm=p.match(/^\/api\/projects\/(proj_(?:[0-9a-f-]{36}|1_[0-9a-f]{24}))(?:\/(.*))?$/);
 if(pm){const project=getProject(pm[1]),action=pm[2]||'';
  if(action==='tests'&&req.method==='GET'){
   // The discovery mode is decided by the TRUST of the project: an
   // untrusted project is never asked to run `playwright test --list`,
   // because that command executes the project config and the test files.
   // `?authoritative=true` asks for the authoritative index explicitly; the
   // trust still decides whether it is allowed.
   //
   // The listing is AWAITED, not run synchronously: it executes the
   // project's own config, which may take seconds. Awaiting it keeps the
   // event loop free, so the Bridge keeps answering (health check, the
   // catalogue of another project, the stop button of a running test) while
   // this project is listed.
   const forced=u.searchParams.get('authoritative');
   const catalog=await discoverTestsAsync(project,store,store.uidRegistry,forced===null?{}:{authoritative:forced==='true'});
   // The registry is written back CELL BY CELL, not as a whole.
   //
   // The listing is AWAITED, so between the moment the registry was read
   // and the moment the answer is built, OTHER requests may have written
   // their own cells into `store.uidRegistry`. Writing the whole snapshot
   // back would therefore ERASE them: a slow listing of project A that
   // finished after project B had been discovered would drop B's entries.
   //
   // So only the cell of THIS project is merged into the CURRENT registry,
   // and the cells of the other projects are kept as they are now.
   //
   // THE CELL IS LOOKED UP BY THE CATALOG'S OWN KEY. The catalogue is built
   // with `projectUidOf(project)` as its project key, so that is the key its
   // cell is filed under. Looking the cell up by `project.uid` / `project.id`
   // instead finds NOTHING for a LEGACY project record -- one that has no
   // `uid` field and whose `id` is still the old `proj_<uuid>` -- because
   // the catalogue filed its cell under the recomputed `proj_1_<hash>`.
   // The cell was then silently dropped and the registry of an unmigrated
   // installation was never saved (measured by the round-3 reviewer: the
   // registry slots went from `["proj_1_..."]` to `[]`).
   //
   // So the key is the one the catalogue REPORTED (`catalog.projectUid`),
   // with the recomputed UID as the fallback. The registry is then filed
   // under that same key, so the cell and its slot always agree.
   const projectKey=catalog.projectUid??projectUidOf(project)??project.uid??project.id;
   const cell=catalog.registry?.projects?.[projectKey];
   store.uidRegistry={
    ...store.uidRegistry,
    version:catalog.registry?.version??store.uidRegistry?.version??1,
    projects:{
     ...(store.uidRegistry?.projects??{}),
     ...(cell?{[projectKey]:cell}:{})
    }
   };
   saveState(store);
   return respond(res,200,{...catalog,project:cleanProject(project)});
  }
  if(action==='trust'&&req.method==='GET'){
   return respond(res,200,{trust:trustOf(store,project),project:cleanProject(project)});
  }
  if(action==='trust'&&req.method==='POST'){
   const b=await body(req);
   if(b.trust!=='trusted'&&b.trust!=='untrusted')return err(res,400,'INVALID_TRUST_VALUE');
   store=withTrust(store,project,{trust:b.trust,reason:b.reason||''});saveState(store);
   return respond(res,200,{trust:trustOf(store,project),project:cleanProject(project)});
  }
  if(action==='runners'&&req.method==='GET'){
   return respond(res,200,{runners:listRunners(),capabilities:capabilityMatrix(project),project:cleanProject(project)});
  }
  // --- ATS-212: the environment profiles -----------------------------------
  //
  // The routes are under the project, because a profile belongs to a
  // project: its whitelist, its identifier and its variables are all
  // scoped by the project they configure.
  //
  // The API answers with the PUBLIC view of a profile -- the identifier, the
  // tier and the NAMES of the variables. The VALUES never cross the wire:
  // a profile may hold a base URL that the caller already knows, but the
  // rule is uniform, and a value that turns out to be sensitive later
  // cannot leak through an API that already shipped.
  if(action==='env'&&req.method==='GET'){
   const store_=envStoreOf(store);
   const profiles=profilesOfProject(store_,projectKeyOf(project)).map(publicProfile);
   const whitelist=whitelistForProject(store_,project);
   return respond(res,200,{
    profiles,
    environments:[...ENVIRONMENTS],
    whitelist:{names:whitelist.names,source:whitelist.source},
   });
  }
  if(action==='env'&&req.method==='POST'){
   const b=await body(req);
   const store_=envStoreOf(store);
   let built;
   try{
    built=upsertProfile(store_,project,{name:b.name,environment:b.environment,variables:b.variables},{now:now()});
   }catch(e){
    // A refused variable is a REFUSAL, not a silent drop. The caller is
    // told WHICH name was refused and WHY, so the request can be fixed.
    if(e.code==='INVALID_ENV_PROFILE')return err(res,400,'INVALID_ENV_PROFILE',{problems:e.problems});
    throw e;
   }
   if(built.rejected.length){
    // The whole request is refused: a caller that asked for a variable
    // that is not allowed should not be handed a partial profile that
    // behaves differently from what they asked for.
    return err(res,400,'ENV_VARIABLE_NOT_ALLOWED',{rejected:built.rejected});
   }
   saveState(store);
   return respond(res,200,{profile:publicProfile(built.profile)});
  }
  if(action==='env'&&req.method==='DELETE'){
   const store_=envStoreOf(store);
   const ref=u.searchParams.get('ref');
   if(!ref)return err(res,400,'ENV_PROFILE_REF_REQUIRED');
   if(!removeProfile(store_,project,ref))return err(res,404,'ENV_PROFILE_NOT_FOUND');
   saveState(store);
   return respond(res,200,{removed:ref});
  }
  if(action==='env-whitelist'&&req.method==='GET'){
   const store_=envStoreOf(store);
   const whitelist=whitelistForProject(store_,project);
   return respond(res,200,{whitelist:{names:whitelist.names,source:whitelist.source}});
  }
  if(action==='env-whitelist'&&req.method==='PUT'){
   const b=await body(req);
   const store_=envStoreOf(store);
   try{setWhitelist(store_,project,b.names);}
   catch(e){
    if(e.code==='INVALID_ENV_WHITELIST')return err(res,400,'INVALID_ENV_WHITELIST',{problems:e.problems});
    throw e;
   }
   saveState(store);
   const whitelist=whitelistForProject(store_,project);
   return respond(res,200,{whitelist:{names:whitelist.names,source:whitelist.source}});
  }
  if(action==='runners'&&req.method==='POST'){
   const b=await body(req);if(b.capabilities!==undefined&&!Array.isArray(b.capabilities))return err(res,400,'CAPABILITIES_NOT_AN_ARRAY');
   const requested=Array.isArray(b.capabilities)?b.capabilities:[];
   try{
    // A caller that pinned a runner gets an error when that runner cannot
    // satisfy the request -- falling back to a different engine would run
    // something the caller did not ask for.
    if(b.runner){
     const chosen=selectAdapterOrThrow(project,requested,{preferred:b.runner});
     return respond(res,200,{selected:chosen.adapter.kind,negotiation:chosen.negotiation,rejected:chosen.rejected||[]});
    }
    const chosen=selectAdapter(project,requested);
    return respond(res,200,{selected:chosen.adapter.kind,negotiation:chosen.negotiation,rejected:chosen.rejected});
   }catch(e){
    if(e instanceof AdapterError)return err(res,e.code==='UNKNOWN_RUNNER'?404:409,e.code,negotiationFailure(e));
    throw e;
   }
  }
  if(action==='source'&&req.method==='GET')return respond(res,200,readSource(project,u.searchParams.get('file')));
  if(action==='source'&&req.method==='PUT'){const b=await body(req);return respond(res,200,writeSource(project,b.file,b.content,b.baseHash));}
  if(action==='run'&&req.method==='POST'){
   if(store.runs.some(x=>x.projectId===project.id&&['running','queued','cancelling'].includes(x.status)))throw new Error('PROJECT_ALREADY_RUNNING');
   const b=await body(req),file=b.file||null;if(b.capabilities!==undefined&&!Array.isArray(b.capabilities))return err(res,400,'CAPABILITIES_NOT_AN_ARRAY');if(file)readSource(project,file);
   // Pick the runner by capability negotiation, not by a hardcoded name. A
   // caller may pin one with `runner`; otherwise the first runner that
   // supports the required operations wins.
   const explicit=Array.isArray(b.capabilities)&&b.capabilities.length>0;
   const pinned=typeof b.runner==='string'&&b.runner?b.runner:null;
   const requested=explicit?b.capabilities:['discover','start','stop','collect'];
   let chosen;
   try{
    // A PINNED runner must not silently fall back to a different engine: the
    // caller asked for that engine, so failing is the honest answer.
    chosen=pinned
     ? selectAdapterOrThrow(project,requested,{preferred:pinned})
     : selectAdapter(project,requested);
   }
   catch(e){
    if(!(e instanceof AdapterError))throw e;
    // An EXPLICIT negotiation request that no runner can satisfy is a
    // client-side condition: the caller asked for a capability nobody has.
    // Answer it with the code and the adapter's own reason (409), not a 500.
    if(explicit||pinned)return err(res,e.code==='UNKNOWN_RUNNER'?404:409,e.code,negotiationFailure(e));
    // The DEFAULT request ("just run the tests") keeps the v0.1 contract of
    // docs/04-DETAILED-DESIGN.md §7: the run is accepted (202) and then fails
    // EXPLICITLY with status=error and the reason the engine is missing.
    // Falling back to the first adapter makes start() raise that reason.
    chosen={adapter:getAdapter('playwright'),negotiation:{requested}};
   }
   const gitCommit=gitInfo(project.root).commit;
   const projectUid=projectUidOf(project);
   // The execution sequence is recorded on the run itself and backed by a
   // durable per project counter, so a sequence number is never reused even
   // after the run history is trimmed.
   const history=store.runs.filter(x=>x.projectId===project.id);
   const seq=nextRunSeq(history,store.runCounters?.[project.id]??0);
   store.runCounters=store.runCounters??{};
   store.runCounters[project.id]=seq;
   const uid=runUidFor({projectUid,gitCommit,file,seq});
   // ATS-212: the environment profile the run runs under.
   //
   // The run request may name a profile (`env`). The profile is looked up in
   // the project's own profiles -- a run of project A cannot use the profile
   // of project B -- and a name that does not exist is a REFUSAL, not a
   // silent fallback to "no profile": a run that was supposed to run
   // against the staging base URL must not quietly run against the default.
   const envStore_=envStoreOf(store);
   let envProfile=null;
   // ATS-212: the profile is looked up under the SAME key the write, the
   // list and the delete path use (`projectKeyOf`), so a profile the API
   // lists can always be used by a run.
   const envProjectKey=projectKeyOf(project);
   if(b.env!==undefined&&b.env!==null&&b.env!==''){
    envProfile=findProfile(envStore_,envProjectKey,b.env);
    if(!envProfile)return err(res,404,'ENV_PROFILE_NOT_FOUND',{ref:String(b.env)});
   }
   // ATS-212: THE WHITELIST CONSTRAINS THE RUN, NOT ONLY THE WRITE.
   //
   // A profile is written against the whitelist that was in force at that
   // moment; the whitelist can be tightened afterwards. A run that happens
   // later must then NOT carry the variables that were removed -- otherwise
   // the whitelist is only a write-time check and the variable still
   // reaches the code under test, which is exactly the boundary the
   // whitelist exists to draw.
   //
   // The variables the CURRENT whitelist no longer permits are FILTERED OUT
   // of the runner environment and REPORTED on the run record, so a reader
   // can see that the profile carried them and that they did not reach the
   // runner. A filter (rather than a refusal) is what keeps a tightened
   // whitelist from turning every existing profile into a dead profile: the
   // run still happens, with exactly the variables that are still allowed.
   const envWhitelist=whitelistForProject(envStore_,project);
   const envFiltered=envProfile?filterProfileVariables(envProfile,envWhitelist.names):{variables:{},refused:[]};
   // The names of the variables the run carried -- NEVER their values. The
   // run record is archived, mirrored into SQLite and shipped as evidence;
   // a value may be sensitive, a name is what a reader of the run needs.
   // The names are the ones that ACTUALLY reached the runner, so the record
   // does not claim a variable the whitelist took away.
   const envVarNameList=envFiltered.variables?Object.keys(envFiltered.variables).sort():[];
   const run={id:uid,uid,seq,projectId:project.id,projectUid,projectName:project.name,file,gitCommit,status:RUN_STATUS.QUEUED,createdAt:now(),startedAt:null,finishedAt:null,eventSeq:0,events:[],log:'',summary:null,artifacts:[],runner:chosen.adapter.kind,capabilities:chosen.negotiation.requested,envUid:envProfile?(envProfile.uid||envProfile.id):null,envVariables:envVarNameList,envName:envProfile?envProfile.name:null,envTier:envProfile?envProfile.environment:null,...(envFiltered.refused.length?{envRefused:envFiltered.refused}:{})};
   store.runs.unshift(run);store.runs=store.runs.slice(0,500);saveState(store);startRun(project,run,chosen.adapter,envProfile,envFiltered.variables);return respond(res,202,{run});
  }
  if(action==='lineage'&&req.method==='GET'){
   const dir=path.join(project.root,'.aitest');let requirements=[],links=[];
   try{requirements=JSON.parse(fs.readFileSync(path.join(dir,'requirements.json'),'utf8'));}catch{}
   try{links=JSON.parse(fs.readFileSync(path.join(dir,'traceability.json'),'utf8'));}catch{}
   return respond(res,200,{requirements,links});
  }
 }
 if(p==='/api/runs'&&req.method==='GET')return respond(res,200,{runs:store.runs.map(({log,...r})=>({...r,logLength:log?.length||0}))});
 const rm=p.match(/^\/api\/runs\/(run_(?:[0-9a-f-]{36}|1_[0-9a-f]{24}))(?:\/(.*))?$/);
 if(rm){const r=getRun(rm[1]),action=rm[2]||'';
  if(action===''&&req.method==='GET')return respond(res,200,{run:r});
  if(action==='stop'&&req.method==='POST'){cancelRun(r);return respond(res,200,{status:r.status});}
  if(action==='events'&&req.method==='GET'){
     const read=readRunEvents(r.id);
     return respond(res,200,{
      events:read.events,
      // The damage of the log is REPORTED, not hidden: a reader has to know
      // that a line was skipped, and that the log itself is missing.
      unreadable:read.unreadable,
      missing:read.missing,
      truncated:read.truncated,
     });
    }
    // ATS-208: the replay. The events of the run, folded in their sequence
    // order, yield the status the run is in. The answer says whether the
    // replay AGREES with the run record, and it reports the gaps in the
    // sequence -- a hole means an event was lost, and the reader has to know.
    //
    // The answer ALSO reports whether the event stream is a VALID description
    // of a run: a stream that violates the state machine does not describe
    // a run, and it must not be reported as agreeing with one.
    if(action==='replay'&&req.method==='GET'){
     const read=readRunEvents(r.id);
     const replay=replayEvents(read.events);
     return respond(res,200,{
      runId:r.id,
      status:r.status,
      replayedStatus:replay.status,
      // The replay agrees with the record when both name the same status.
      // A run whose events determine NO status is a disagreement too: the
      // stream does not describe the run. A stream that VIOLATES the state
      // machine is a disagreement as well: it describes a run that never
      // existed, so it cannot agree with anything.
      agrees:replay.status===r.status&&replay.valid,
      valid:replay.valid,
      violations:replay.violations,
      terminal:replay.terminal,
      sequence:replay.sequence,
      // The holes in the sequence: the numbers that are MISSING from the
      // stream. The sequence starts at 1, so a log that lost its first
      // events is not an intact log either.
      gaps:replay.gaps,
      // The numbers that are used MORE THAN ONCE: two events claiming the
      // same place in the stream. The metadata layer's primary key
      // (run_uid, seq) refuses such a pair.
      duplicates:replay.duplicates,
      // The events that carry no usable sequence number.
      unsequenced:replay.unsequenced,
      events:replay.events,
      // The damage of the log is reported here too, so that a reader of the
      // replay knows that the stream it folds is not the whole story.
      unreadable:read.unreadable,
      missing:read.missing,
      truncated:read.truncated,
     });
    }
  if(action==='artifact'&&req.method==='GET'){
   const file=u.searchParams.get('file'),actual=artifactPath(r.id,file);const type=mime[path.extname(actual)]||'application/octet-stream';
   res.writeHead(200,{'Content-Type':type,'Content-Disposition':`attachment; filename="${path.basename(actual).replace(/[^a-zA-Z0-9._-]/g,'_')}"`,'X-Content-Type-Options':'nosniff'});return fs.createReadStream(actual).pipe(res);
  }
  // ATS-209: the VERIFICATION of the archived evidence.
  //
  // The answer recomputes the digest of every file the manifest lists and
  // reports what does not match. It is a READ: nothing is written, nothing
  // is repaired, and the answer is the honest one -- a file that was
  // changed after the run was archived is reported as changed, with the
  // digest it should have and the digest it has.
  if(action==='evidence'&&req.method==='GET'){
     const result=verifyEvidence(runDir(r.id));
     return respond(res,200,{
      runId:r.id,
      verified:result.verified,
      ok:result.ok,
      checked:result.checked,
      missing:result.missing,
      changed:result.changed,
      extra:result.extra,
      // ATS-209 review round 1 (E3, E7): the entries the manifest names
      // outside the run folder are REFUSED, not followed; and the files the
      // retention policy removed are reported as `cleaned`, so they are not
      // mistaken for a tamper.
      rejected:result.rejected,
      cleaned:result.cleaned,
      truncated:result.truncated,
      reason:result.reason,
      evidence:r.evidence??null,
      manifestVersion:result.manifest?.version??null,
     });
    }
  // ATS-209: the MANIFEST of a run, as it was written.
  if(action==='manifest'&&req.method==='GET'){
   const result=verifyEvidence(runDir(r.id));
   if(!result.manifest)return err(res,404,'MANIFEST_NOT_FOUND',{reason:result.reason});
   return respond(res,200,{runId:r.id,manifest:result.manifest});
  }
 }
 // ATS-209: the RETENTION policy of the whole data directory.
 //
 // The plan is a READ: it says which runs are expired, how much space
 // their evidence takes, and how much of it is stored twice. Nothing is
 // removed by it.
 if(p==='/api/evidence/retention'&&req.method==='GET'){
  const days=u.searchParams.get('days');
  const period=days===null?DEFAULT_RETENTION_DAYS:Number(days);
  if(!Number.isFinite(period)||period<0)return err(res,400,'INVALID_RETENTION_PERIOD');
  const plan=planRetention(store.runs,(run)=>runDir(run.id),{days:period});
  return respond(res,200,{
   days:period,
   expired:plan.expired,
   expiredCount:plan.expiredCount,
   expiredBytes:plan.expiredBytes,
   keptBytes:plan.keptBytes,
   sharedBytes:plan.sharedBytes,
   storeBytes:storeBytes(storeDirOf(dataDir())),
  });
 }
 // ATS-209: the DEDUPLICATION report. It says which evidence content is
 // stored more than once and how many bytes that wastes.
 if(p==='/api/evidence/dedup'&&req.method==='GET'){
  const report=deduplicationReport(evidenceIndexOf(store));
  return respond(res,200,{...report,storeBytes:storeBytes(storeDirOf(dataDir()))});
 }
 if(p==='/api/diagnostics'&&req.method==='GET')return respond(res,200,{runtime:process.version,server:'Node.js bridge',platform:process.platform,pid:process.pid,environment:'local',limitations:['Local trusted repositories only','No process/container sandbox','No account/RBAC','AI provider not connected','WDIO adapter planned'],agentContract:{version:AGENT_CONTRACT_VERSION,status:'CONTRACT_ONLY',note:'The agent contract is defined and enforced; no model provider is wired, so no agent request can reach a model.',writePolicy:'Agents produce diffs only; applying a diff, updating expected results and committing are platform-side operations performed after review.'},pluginContract:{version:PLUGIN_CONTRACT_VERSION,status:'CONTRACT_ONLY',note:'The plugin contract, the permission list and the SDK operation surface are defined and enforced; no plugin host, loader or sandbox exists, so no plugin can be loaded or run.',grantPolicy:'A manifest declares permissions; the host grants them. The effective set is the declared set intersected with the host policy tier.',auditPolicy:'Every SDK call that performs an operation produces an audit event in the host sink, including the denied ones and the ones whose host read failed. The plugin cannot suppress it.',evidencePolicy:'The SHA-256 of an evidence reference is computed by the host resolver, never supplied by the plugin.',proposalPolicy:'The host holds the authoritative proposal record. A proposal the host does not hold, or one whose fields or evidence digests differ from the host record, cannot be reviewed.'},credentialStore:{contract:describeCredentialStore(credentialStore).contract,provider:credentialStore.provider(),note:'Secrets live in the OS credential store; the index file holds references only. No endpoint returns a secret.',available:credentialStore.provider()!==null},egressConsent:{contract:describeEgressConsent().contract,note:'Egress requires a granted consent whose scope still matches the content about to be sent; the platform reads the real files and recomputes the digests.'},egressAudit:{contract:describeEgressAudit().contract,note:'Every egress decision -- allowed or denied -- is recorded. A record names the refs and their digests; it never carries the content and never carries a secret.'}});
 if(p==='/api/agent/contract'&&req.method==='GET')return respond(res,200,describeAgentContract());
if(p==='/api/plugins/contract'&&req.method==='GET')return respond(res,200,describePluginContract());
if(p==='/api/plugins/validate'&&req.method==='POST'){
  // Validation only: it proves a manifest satisfies the plugin contract and
  // reports which permissions the host would actually grant under the given
  // policy tier. It does not load, run or install a plugin.
  const b=await body(req);
  const tier=b.tier===undefined?undefined:String(b.tier);
  const validated=validatePluginManifest(b.manifest===undefined?b: b.manifest);
  const resolution=resolvePluginPermissions(validated.permissions,tier);
  return respond(res,200,{valid:true,contract:PLUGIN_CONTRACT_VERSION,manifest:validated,tier:resolution.tier,grantedPermissions:resolution.granted,deniedPermissions:resolution.denied});
}
 if(p==='/api/agent/validate'&&req.method==='POST'){
  // Validation only: it proves a request satisfies the contract. It does not
  // call a model, and it never writes to the project.
  const b=await body(req);
  const validated=validateAgentRequest(b);
  return respond(res,200,{valid:true,contract:validated.contract,requestId:validated.id,role:validated.role,scope:validated.scope,budget:validated.budget,inputRefs:validated.inputs.map(i=>({kind:i.kind,ref:i.ref,digest:i.digest,retrievedAt:i.retrievedAt})),requestedCapabilities:validated.requestedCapabilities,egress:validated.egress});
 }
 // --- ATS-402: the AI data security surface --------------------------------
 if(p==='/api/security/contract'&&req.method==='GET'){
  // The contract description. It names the providers and the flow; it never
  // contains a secret and never lists a stored credential's secret.
  return respond(res,200,{...describeCredentialStore(credentialStore),egressConsent:describeEgressConsent(),egressAudit:describeEgressAudit()});
 }
 if(p==='/api/security/credentials'&&req.method==='GET'){
  // The credential REFERENCES. There is no endpoint that returns a secret.
  return respond(res,200,{credentials:await credentialStore.list(),provider:credentialStore.provider(),available:await credentialStore.available()});
 }
 if(p==='/api/security/credentials'&&req.method==='POST'){
  // Store a secret in the OS credential store. The secret arrives in the
  // request body, goes straight into the credential store, and is never
  // written to state.json, to the credential index, or to the response.
  const b=await body(req);
  const reference=await credentialStore.put({name:b.name,secret:b.secret,purpose:b.purpose??'ai-provider'});
  return respond(res,201,{credential:reference});
 }
 const credRm=p.match(/^\/api\/security\/credentials\/(cred_[0-9a-f]{24})$/);
 if(credRm&&req.method==='GET')return respond(res,200,{credential:await credentialStore.describe(credRm[1])});
 if(credRm&&req.method==='DELETE')return respond(res,200,{credential:await credentialStore.remove(credRm[1])});
 if(p==='/api/security/egress/preview'&&req.method==='POST'){
  // Step 1 of the informed consent: show the user EXACTLY what would leave.
  // The platform reads the real files and recomputes the digests, so the
  // scope shown is the scope that will be sent.
  const b=await body(req);
  const project=getProject(b.projectId);
  const inputs=Array.isArray(b.inputs)?b.inputs:[];
  const scope=buildScope(project,inputs);
  const preview=egressConsentStore.preview(scope.items);
  // The preview carries the scope AND its byte total: the byte count is
  // part of what the user is shown, so it must be the real one.
  return respond(res,200,{preview:{...preview,scope:{...scope,items:scope.items}}});
 }
 if(p==='/api/security/egress/confirm'&&req.method==='POST'){
  // Step 2: the user confirms the scope they were shown. The preview token
  // is consumed here, so the same preview cannot be confirmed twice.
  const b=await body(req);
  const project=getProject(b.projectId);
  const inputs=Array.isArray(b.inputs)?b.inputs:[];
  const scope=buildScope(project,inputs);
  const consent=await egressConsentStore.confirm({previewId:b.previewId,inputs:scope.items,ttlSeconds:b.ttlSeconds});
  // The consent itself is audited: the trail says WHICH scope was authorised,
  // so a later egress can be checked against what the user actually agreed to.
  await egressAuditStore.record({
   event:'consent.granted',outcome:'allowed',consentId:consent.id,projectId:project.id,
   kinds:consent.kinds,items:scope.items,scopeDigest:consent.scopeDigest,
  });
  return respond(res,201,{consent});
 }
 if(p==='/api/security/egress/consents'&&req.method==='GET'){
  return respond(res,200,{consents:await egressConsentStore.all()});
 }
 const consentRm=p.match(/^\/api\/security\/egress\/consents\/(egr_[0-9a-f]{24})$/);
 if(consentRm&&req.method==='DELETE'){
  const revoked=await egressConsentStore.revoke(consentRm[1]);
  await egressAuditStore.record({
   event:'consent.revoked',outcome:'denied',code:'EGRESS_CONSENT_REVOKED',reason:'the user revoked the egress consent',
   consentId:revoked.id,projectId:null,kinds:revoked.kinds,items:[],scopeDigest:revoked.scopeDigest,
  });
  return respond(res,200,{consent:revoked});
 }
 if(p==='/api/security/egress/audit'&&req.method==='GET'){
  // The audit trail. Every record names refs and digests; none carries the
  // content and none carries a secret.
  return respond(res,200,{audit:await egressAuditStore.all()});
 }
 if(p==='/api/security/egress/check'&&req.method==='POST'){
  // The gate itself: it answers "may these inputs leave the machine?".
  // It is the same code path the platform uses before a real egress.
  // EVERY refusal is audited -- including a scope the gate could not resolve
  // (a path outside the project, an unknown project, a malformed input) --
  // with the refs the request named. No file is read for a refusal record.
  const b=await body(req);
  const inputs=Array.isArray(b.inputs)?b.inputs:[];
  const consent=typeof b.consentId==='string'?await egressConsentStore.find(b.consentId):null;
  const deny=async(code,reason,project)=>{
   await egressAuditStore.record({
    event:'egress.denied',outcome:'denied',code,reason,
    consentId:consent?.id??null,projectId:project?.id??null,
    kinds:[...new Set(inputs.map(i=>i?.kind).filter(k=>typeof k==='string'))],items:describeRequestedRefs(inputs),
   });
   return respond(res,/INVALID|UNKNOWN/.test(code)&&code.startsWith('EGRESS_GATE_')?400:403,{error:code,reason});
  };
  let project;
  try{project=getProject(b.projectId);}catch{return deny('EGRESS_GATE_PROJECT_UNKNOWN','the project is not registered',null);}
  const verdict=authorizeEgress({project,inputs,consent,consentStore:egressConsentStore,runResolver:egressRunResolver});
  if(!verdict.allowed)return deny(verdict.code,verdict.reason,project);
  await egressAuditStore.record({
   event:'egress.granted',outcome:'allowed',consentId:consent?.id??null,projectId:project.id,
   kinds:verdict.scope.kinds,items:verdict.scope.items,scopeDigest:verdict.scope.scopeDigest,
  });
  return respond(res,200,{allowed:true,scope:verdict.scope});
 }
 if(p.startsWith('/api/'))return err(res,404,'NOT_FOUND');
 return staticFile(req,res,p);
 }catch(e){const message=e instanceof Error?e.message:String(e);const code=e&&e.code?e.code:'';
 // Agent contract violations are client errors: the request does not satisfy
 // the contract. The code is returned as-is so a caller can branch on it.
 //
 // SCOPE: this mapping applies to AGENT_* errors ONLY. Every other error keeps
 // the pre-ATS-401 behaviour byte for byte (status by message pattern, the
 // message echoed as-is), so ATS-401 does not silently change the API surface
 // for unrelated errors. The path-leak in that echo is a pre-existing defect
 // owned by ATS-112 (docs/16-BASELINE-ADR.md §3.2), not by this task.
 const isAgentError=/^AGENT_/.test(code);
 if(isAgentError){
   const status=400;
   // The details are contract-level values only (the offending field, the
   // limit, the target path). They never contain a local filesystem path.
   const details=e&&e.details&&typeof e.details==='object'?{details:e.details}:{};
   return respond(res,status,{error:code||message,...details});
  }
  // Plugin contract violations are client errors in the same way: the manifest
  // does not satisfy the contract. The scope of this mapping is PLUGIN_* only,
  // so every other error keeps its pre-ATS-512 behaviour byte for byte.
  const isPluginError=/^PLUGIN_/.test(code);
  if(isPluginError){
   const status=400;
   const details=e&&e.details&&typeof e.details==='object'?{details:e.details}:{};
   return respond(res,status,{error:code||message,...details});
  }
  // ATS-402: the credential store and the egress consent are client errors
  // too. The scope of this mapping is CREDENTIAL_* / EGRESS_* only; every
  // other error keeps its pre-ATS-402 behaviour byte for byte.
  //
  // The messages of these codes name the CODE, never the secret and never a
  // local path: `CREDENTIAL_*` messages come from the credential store, and
  // `EGRESS_*` messages describe a scope, not a filesystem location.
  const isSecurityError=/^(CREDENTIAL_|EGRESS_)/.test(code);
  if(isSecurityError){
   const status=/NOT_FOUND/.test(code)?404:/UNAVAILABLE|FAILED/.test(code)?503:400;
   return respond(res,status,{error:code||message});
  }
 const status=/NOT_FOUND/.test(message)?404:/CONFLICT|ALREADY/.test(message)?409:/OUTSIDE|INVALID|REQUIRED|STALE|TOO_LARGE|NOT_INSTALLED/.test(message)?400:500;
 return err(res,status,message);}
});
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))server.listen(PORT,'127.0.0.1',()=>console.log(`AI Test Studio bridge: http://127.0.0.1:${PORT}/fallback.html`));
export {server};
