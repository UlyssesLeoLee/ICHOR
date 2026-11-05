import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState,saveState,validateProjectPath,gitInfo,discoverStatic,readSource,writeSource,safeRunArgs,runDir,filesInRun,artifactPath,parseReport,now,safeId,compactLog,attemptsForRun,acquireBridgeLock,releaseBridgeLock,lockPath,dataDir } from './core.mjs';
import { projectUidFor, projectUidOf, runUidFor, attemptUidFor, nextRunSeq, UID_SCHEME_VERSION } from './uid.mjs';
import { AGENT_CONTRACT_VERSION,describeAgentContract,validateAgentRequest } from './agent.mjs';
import { PLUGIN_CONTRACT_VERSION,describePluginContract,validatePluginManifest,resolvePluginPermissions } from './plugins/contract.mjs';
import { capabilityMatrix,getAdapter,listRunners,selectAdapter,selectAdapterOrThrow , negotiationFailure} from './adapters/registry.mjs';
import { AdapterError } from './adapters/contract.mjs';
import { createCredentialStore,credentialIndexPath,describeCredentialStore } from './security/credentials.mjs';
import { createEgressConsentStore,describeEgressConsent,describeEgressScope } from './security/egress-consent.mjs';
import { authorizeEgress,readScopedInput } from './security/egress-gate.mjs';

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
try{acquireBridgeLock();}
catch(e){console.error(`another process holds the data directory lock (${lockPath()}): ${e.message}`);process.exit(1);}
process.on('exit',()=>releaseBridgeLock());
let store=loadState();
for(const run of store.runs){if(['queued','running'].includes(run.status)){run.status='interrupted';run.finishedAt=now();run.error='Server restarted while run was active';}}
saveState(store);

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

/**
 * 解析一次外传的范围：**由平台侧读真实文件并复算摘要**。
 *
 * 这是 ATS-401 契约层留下的缺口的落点（`docs/17-AGENT-CONTRACT.md` §6）：
 * 契约层的 `digest` 由请求方提供，只能证明「二者自洽」；这里的摘要由
 * 本机文件系统给出，于是「`ref` 确实对应那份源内容」才成立。
 */
async function buildScope(project,inputs){
  const resolved=[];
  for(const input of inputs){
    if(!input||typeof input!=='object'){const e=new Error('EGRESS_GATE_INPUT_INVALID');e.code='EGRESS_GATE_INPUT_INVALID';throw e;}
    if(input.kind==='run'){
      const run=getRun(input.ref);
      const content=JSON.stringify({runId:run.id,status:run.status,summary:run.summary??null});
      resolved.push({kind:'run',ref:input.ref,digest:crypto.createHash('sha256').update(content,'utf8').digest('hex'),content});
      continue;
    }
    if(input.kind==='requirement'){
      // The requirement document lives in the project's .aitest directory.
      const rel=String(input.ref||'requirements.json');
      const joined=path.resolve(project.root,'.aitest',rel);
      if(!joined.startsWith(path.resolve(project.root)+path.sep)){const e=new Error('EGRESS_GATE_SCOPE_INVALID');e.code='EGRESS_GATE_SCOPE_INVALID';throw e;}
      let content;
      try{content=fs.readFileSync(joined,'utf8');}catch{const e=new Error('EGRESS_GATE_INPUT_INVALID');e.code='EGRESS_GATE_INPUT_INVALID';throw e;}
      resolved.push({kind:'requirement',ref:rel,digest:crypto.createHash('sha256').update(content,'utf8').digest('hex'),content});
      continue;
    }
    resolved.push(readScopedInput(project.root,input));
  }
  return describeEgressScope(resolved);
}

const ORIGINS=new Set([`http://localhost:${PORT}`,`http://127.0.0.1:${PORT}`,'http://localhost:3000','http://127.0.0.1:3000','tauri://localhost','http://tauri.localhost','https://tauri.localhost']);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.zip':'application/zip','.txt':'text/plain; charset=utf-8','.map':'application/json'};
const respond=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
const err=(res,status,msg,extra)=>respond(res,status,extra?{error:msg,...extra}:{error:msg});
async function body(req){let buf='';for await(const chunk of req){buf+=chunk;if(buf.length>1_200_000)throw new Error('PAYLOAD_TOO_LARGE');}return buf?JSON.parse(buf):{};}
function getProject(id){const p=store.projects.find(p=>p.id===id||p.uid===id);if(!p)throw new Error('PROJECT_NOT_FOUND');return p;}
function getRun(id){const r=store.runs.find(r=>r.id===id||r.uid===id);if(!r)throw new Error('RUN_NOT_FOUND');return r;}
function cleanProject(p){let git={branch:'-',commit:'-',dirty:false};try{git=gitInfo(p.root);}catch{} return {...p,uid:p.uid||projectUidOf(p),git};}
function writeEvent(run,type,data={}){const ev={seq:++run.eventSeq,at:now(),type,data};fs.appendFileSync(path.join(runDir(run.id),'events.jsonl'),JSON.stringify(ev)+'\n');}
function finishRun(run,code,signal){
 if(run.status!=='running'&&run.status!=='cancelling')return;
 const cancelled=run.status==='cancelling';
 run.status=cancelled?'cancelled':code===0?'passed':'failed';run.exitCode=code;run.finishedAt=now();
 const folder=runDir(run.id);
 // Collect through the adapter that started the run, so every engine's
 // native result file is mapped onto the same summary shape.
 const adapter=run.runner?getAdapter(run.runner):null;
 // The RAW Playwright report is parsed separately from the adapter's summary:
 // the adapter maps the engine's vocabulary onto the common result model, but
 // the Attempt records need the per-retry details (line, retry index and the
 // RESULT level status) that only the raw report carries.
 let rawSummary=null;
 const reportFile=path.join(folder,'report.json');
 if(fs.existsSync(reportFile)){try{rawSummary=parseReport(JSON.parse(fs.readFileSync(reportFile,'utf8')));}catch(e){run.reportWarning=String(e.message);}}
 if(adapter){try{const collected=adapter.collect({outputDir:folder});if(collected&&collected.summary)run.summary=collected.summary;}catch(e){run.reportWarning=String(e.message);}}
 if(!run.summary)run.summary=rawSummary;
 if(!run.summary)run.summary={passed:0,failed:0,skipped:0,flaky:0,total:0,executions:0,cases:[]};
 // The report names the test files relative to the Playwright rootDir, the
 // registry stores them relative to the project root. The project root is
 // needed to reconcile the two spellings.
 const proj=store.projects.find(p=>p.id===run.projectId||p.uid===run.projectId||p.uid===run.projectUid);
 run.attempts=attemptsForRun({...run,projectRoot:proj?.root??null},rawSummary??run.summary,store.uidRegistry);
 run.artifacts=filesInRun(run.id).filter(x=>!['events.jsonl','stdout.log'].includes(x.file));
 const manifest={version:1,runId:run.id,projectUid:run.projectUid||null,projectId:run.projectId,sourceCommit:run.gitCommit,runner:run.runner||'playwright',status:run.status,createdAt:run.startedAt,finishedAt:run.finishedAt,artifacts:run.artifacts,attempts:run.attempts};
 fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2));
 writeEvent(run,'run.finished',{status:run.status,code,signal});jobs.delete(run.id);saveState(store);
}
function startRun(project,run,adapter){
 const folder=runDir(run.id);fs.mkdirSync(folder,{recursive:true});
 writeEvent(run,'run.queued',{file:run.file,runner:run.runner});
 let handle;
 try{handle=adapter.start({project,run,file:run.file,outputDir:folder});}
 catch(e){run.status='error';run.error=e.message;run.finishedAt=now();writeEvent(run,'run.error',{error:e.message});saveState(store);return;}
 const cp=handle.child;
 run.status='running';run.pid=cp.pid;run.startedAt=now();run.command=[handle.command,...handle.args];jobs.set(run.id,{child:cp,handle});writeEvent(run,'run.started',{pid:cp.pid,runner:run.runner});saveState(store);
 for(const stream of [cp.stdout,cp.stderr])stream.on('data',buf=>{
  const str=buf.toString('utf8');run.log=compactLog((run.log||'')+str);
  fs.appendFileSync(path.join(folder,'stdout.log'),str);
 });
 cp.on('error',e=>{run.error=e.message;finishRun(run,127,'spawn-error');});
 cp.on('close',(code,signal)=>finishRun(run,code,signal));
}
function cancelRun(run){
 const job=jobs.get(run.id);if(!job)throw new Error('RUN_NOT_ACTIVE');run.status='cancelling';writeEvent(run,'run.cancelling');saveState(store);
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
 res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-ATS-Token');res.setHeader('Vary','Origin');}
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
   const catalog=discoverStatic(project,store.uidRegistry);
   store.uidRegistry=catalog.registry;saveState(store);
   return respond(res,200,{...catalog,project:cleanProject(project)});
  }
  if(action==='runners'&&req.method==='GET'){
   return respond(res,200,{runners:listRunners(),capabilities:capabilityMatrix(project),project:cleanProject(project)});
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
   const run={id:uid,uid,seq,projectId:project.id,projectUid,projectName:project.name,file,gitCommit,status:'queued',createdAt:now(),startedAt:null,finishedAt:null,eventSeq:0,log:'',summary:null,artifacts:[],runner:chosen.adapter.kind,capabilities:chosen.negotiation.requested};
   store.runs.unshift(run);store.runs=store.runs.slice(0,500);saveState(store);startRun(project,run,chosen.adapter);return respond(res,202,{run});
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
    const f=path.join(runDir(r.id),'events.jsonl');return respond(res,200,{events:fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]});
  }
  if(action==='artifact'&&req.method==='GET'){
   const file=u.searchParams.get('file'),actual=artifactPath(r.id,file);const type=mime[path.extname(actual)]||'application/octet-stream';
   res.writeHead(200,{'Content-Type':type,'Content-Disposition':`attachment; filename="${path.basename(actual).replace(/[^a-zA-Z0-9._-]/g,'_')}"`,'X-Content-Type-Options':'nosniff'});return fs.createReadStream(actual).pipe(res);
  }
 }
 if(p==='/api/diagnostics'&&req.method==='GET')return respond(res,200,{runtime:process.version,server:'Node.js bridge',platform:process.platform,pid:process.pid,environment:'local',limitations:['Local trusted repositories only','No process/container sandbox','No account/RBAC','AI provider not connected','WDIO adapter planned'],agentContract:{version:AGENT_CONTRACT_VERSION,status:'CONTRACT_ONLY',note:'The agent contract is defined and enforced; no model provider is wired, so no agent request can reach a model.',writePolicy:'Agents produce diffs only; applying a diff, updating expected results and committing are platform-side operations performed after review.'},pluginContract:{version:PLUGIN_CONTRACT_VERSION,status:'CONTRACT_ONLY',note:'The plugin contract, the permission list and the SDK operation surface are defined and enforced; no plugin host, loader or sandbox exists, so no plugin can be loaded or run.',grantPolicy:'A manifest declares permissions; the host grants them. The effective set is the declared set intersected with the host policy tier.',auditPolicy:'Every SDK call produces an audit event in the host sink, including the denied ones. The plugin cannot suppress it.',evidencePolicy:'The SHA-256 of an evidence reference is computed by the host resolver, never supplied by the plugin.'},credentialStore:{contract:describeCredentialStore(credentialStore).contract,provider:credentialStore.provider(),note:'Secrets live in the OS credential store; the index file holds references only. No endpoint returns a secret.',available:credentialStore.provider()!==null},egressConsent:{contract:describeEgressConsent().contract,note:'Egress requires a granted consent whose scope still matches the content about to be sent; the platform reads the real files and recomputes the digests.'}});
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
  return respond(res,200,{...describeCredentialStore(credentialStore),egressConsent:describeEgressConsent()});
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
  const scope=await buildScope(project,inputs);
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
  const scope=await buildScope(project,inputs);
  const consent=await egressConsentStore.confirm({previewId:b.previewId,inputs:scope.items,ttlSeconds:b.ttlSeconds});
  return respond(res,201,{consent});
 }
 if(p==='/api/security/egress/consents'&&req.method==='GET'){
  return respond(res,200,{consents:await egressConsentStore.all()});
 }
 const consentRm=p.match(/^\/api\/security\/egress\/consents\/(egr_[0-9a-f]{24})$/);
 if(consentRm&&req.method==='DELETE')return respond(res,200,{consent:await egressConsentStore.revoke(consentRm[1])});
 if(p==='/api/security/egress/check'&&req.method==='POST'){
  // The gate itself: it answers "may these inputs leave the machine?".
  // It is the same code path the platform uses before a real egress.
  const b=await body(req);
  const project=getProject(b.projectId);
  const inputs=Array.isArray(b.inputs)?b.inputs:[];
  const consent=b.consentId?await egressConsentStore.find(b.consentId):null;
  const verdict=authorizeEgress({project,inputs,consent,consentStore:egressConsentStore});
  if(!verdict.allowed)return respond(res,403,{error:verdict.code,reason:verdict.reason});
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
