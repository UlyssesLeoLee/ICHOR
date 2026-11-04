import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState,saveState,validateProjectPath,gitInfo,discoverStatic,readSource,writeSource,safeRunArgs,runDir,filesInRun,artifactPath,parseReport,now,safeId,compactLog } from './core.mjs';
import { capabilityMatrix,getAdapter,listRunners,selectAdapter } from './adapters/registry.mjs';
import { AdapterError,requireCapability } from './adapters/contract.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,'..');
const PORT=Number(process.env.ATS_PORT||4577);
const TOKEN=crypto.randomBytes(24).toString('hex');
const jobs=new Map();
let store=loadState();
for(const run of store.runs){if(['queued','running'].includes(run.status)){run.status='interrupted';run.finishedAt=now();run.error='Server restarted while run was active';}}
saveState(store);

const ORIGINS=new Set([`http://localhost:${PORT}`,`http://127.0.0.1:${PORT}`,'http://localhost:3000','http://127.0.0.1:3000','tauri://localhost','http://tauri.localhost','https://tauri.localhost']);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.zip':'application/zip','.txt':'text/plain; charset=utf-8','.map':'application/json'};
const respond=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
const err=(res,status,msg)=>respond(res,status,{error:msg});
async function body(req){let buf='';for await(const chunk of req){buf+=chunk;if(buf.length>1_200_000)throw new Error('PAYLOAD_TOO_LARGE');}return buf?JSON.parse(buf):{};}
function getProject(id){const p=store.projects.find(p=>p.id===id);if(!p)throw new Error('PROJECT_NOT_FOUND');return p;}
function getRun(id){const r=store.runs.find(r=>r.id===id);if(!r)throw new Error('RUN_NOT_FOUND');return r;}
function cleanProject(p){let git={branch:'-',commit:'-',dirty:false};try{git=gitInfo(p.root);}catch{} return {...p, git};}
function writeEvent(run,type,data={}){const ev={seq:++run.eventSeq,at:now(),type,data};fs.appendFileSync(path.join(runDir(run.id),'events.jsonl'),JSON.stringify(ev)+'\n');}
function finishRun(run,code,signal){
 if(run.status!=='running'&&run.status!=='cancelling')return;
 const cancelled=run.status==='cancelling';
 run.status=cancelled?'cancelled':code===0?'passed':'failed';run.exitCode=code;run.finishedAt=now();
 const folder=runDir(run.id);
 // Collect through the adapter that started the run, so every engine's
 // native result file is mapped onto the same summary shape.
 const adapter=run.runner?getAdapter(run.runner):null;
 if(adapter){try{const collected=adapter.collect({outputDir:folder});if(collected&&collected.summary)run.summary=collected.summary;}catch(e){run.reportWarning=String(e.message);}}
 if(!run.summary){const reportFile=path.join(folder,'report.json');if(fs.existsSync(reportFile)){try{run.summary=parseReport(JSON.parse(fs.readFileSync(reportFile,'utf8')));}catch(e){run.reportWarning=String(e.message);}}}
 run.artifacts=filesInRun(run.id).filter(x=>!['events.jsonl','stdout.log'].includes(x.file));
 const manifest={version:1,runId:run.id,projectId:run.projectId,sourceCommit:run.gitCommit,runner:run.runner||'playwright',status:run.status,createdAt:run.startedAt,finishedAt:run.finishedAt,artifacts:run.artifacts};
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
  if(store.projects.find(x=>x.root===actual))throw new Error('PROJECT_ALREADY_REGISTERED');
  const project={id:safeId('proj'),name:path.basename(actual),root:actual,addedAt:now()};store.projects.push(project);saveState(store);return respond(res,201,{project:cleanProject(project)});
 }
 const pm=p.match(/^\/api\/projects\/(proj_[0-9a-f-]{36})(?:\/(.*))?$/);
 if(pm){const project=getProject(pm[1]),action=pm[2]||'';
  if(action==='tests'&&req.method==='GET')return respond(res,200,{...discoverStatic(project),project:cleanProject(project)});
  if(action==='runners'&&req.method==='GET'){
   return respond(res,200,{runners:listRunners(),capabilities:capabilityMatrix(project),project:cleanProject(project)});
  }
  if(action==='runners'&&req.method==='POST'){
   const b=await body(req);
   const requested=Array.isArray(b.capabilities)?b.capabilities:[];
   try{
    const chosen=selectAdapter(project,requested,{preferred:b.runner});
    return respond(res,200,{selected:chosen.adapter.kind,negotiation:chosen.negotiation,rejected:chosen.rejected});
   }catch(e){
    if(e instanceof AdapterError)return err(res,409,e.code);
    throw e;
   }
  }
  if(action==='source'&&req.method==='GET')return respond(res,200,readSource(project,u.searchParams.get('file')));
  if(action==='source'&&req.method==='PUT'){const b=await body(req);return respond(res,200,writeSource(project,b.file,b.content,b.baseHash));}
  if(action==='run'&&req.method==='POST'){
   if(store.runs.some(x=>x.projectId===project.id&&['running','queued','cancelling'].includes(x.status)))throw new Error('PROJECT_ALREADY_RUNNING');
   const b=await body(req),file=b.file||null;if(file)readSource(project,file);
   // Pick the runner by capability negotiation, not by a hardcoded name. A
   // caller may pin one with `runner`; otherwise the first runner that
   // supports the required operations wins.
   const requested=Array.isArray(b.capabilities)&&b.capabilities.length?b.capabilities:['discover','start','stop','collect'];
   let chosen;
   try{chosen=selectAdapter(project,requested,{preferred:b.runner});}
   catch(e){if(e instanceof AdapterError)return err(res,409,e.code);throw e;}
   const run={id:safeId('run'),projectId:project.id,projectName:project.name,file,gitCommit:gitInfo(project.root).commit,status:'queued',createdAt:now(),startedAt:null,finishedAt:null,eventSeq:0,log:'',summary:null,artifacts:[],runner:chosen.adapter.kind,capabilities:chosen.negotiation.requested};
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
 const rm=p.match(/^\/api\/runs\/(run_[0-9a-f-]{36})(?:\/(.*))?$/);
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
 if(p==='/api/diagnostics'&&req.method==='GET')return respond(res,200,{runtime:process.version,server:'Node.js bridge',platform:process.platform,pid:process.pid,environment:'local',limitations:['Local trusted repositories only','No process/container sandbox','No account/RBAC','AI provider not connected','WDIO adapter planned']});
 if(p.startsWith('/api/'))return err(res,404,'NOT_FOUND');
 return staticFile(req,res,p);
 }catch(e){const message=e instanceof Error?e.message:String(e);const status=/NOT_FOUND/.test(message)?404:/CONFLICT|ALREADY/.test(message)?409:/OUTSIDE|INVALID|REQUIRED|STALE|TOO_LARGE|NOT_INSTALLED/.test(message)?400:500;return err(res,status,message);}
});
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))server.listen(PORT,'127.0.0.1',()=>console.log(`AI Test Studio bridge: http://127.0.0.1:${PORT}/fallback.html`));
export {server};
