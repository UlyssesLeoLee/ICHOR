'use client';
import React,{useCallback,useEffect,useMemo,useState} from 'react';
import dynamic from 'next/dynamic';
import {Activity,BookOpen,Box,ChartNoAxesCombined,CheckCircle2,ChevronRight,Clock,Code2,Download,FileCode2,FilePlus2,FileSearch,FolderGit2,GitBranch,GitCommitHorizontal,Inbox,KeyRound,LayoutDashboard,Layers3,Loader2,Lock,Network,Play,RefreshCcw,Save,Search,ShieldAlert,Square,Terminal,TestTube2,Trash2,TriangleAlert,XCircle} from 'lucide-react';
import {api,cancellableApi,downloadArtifact,type Project,type TestDef,type TestCatalog,type Run,type Source,type CredentialRef,type CredentialStatus,type EgressScope,type EgressPreview,type EgressConsent,type SecurityContract,type EgressAuditRecord,type EvidenceMaterial} from '../lib/api';
// ATS-111: the WORKBENCH STATE MODEL. The four states -- empty / failed /
// cancelled / loading -- are defined ONCE, here, and the unit tests assert
// on them (tests/workbench-state.test.mjs) without a browser. The view
// below only renders what the model says.
import {WORKBENCH_STATES,deriveWorkbenchState,isTextEntry,keyCommandFor,keyboardHelpLines,type WorkbenchStateKind} from '../lib/workbench-state.mjs';
// ATS-216: the QUALITY OVERVIEW module. It lives in `public/` so that the
// Next workbench and the zero-dependency portable UI import the SAME
// implementation -- the metrics cannot drift apart between the two UIs.
import {buildQualityOverview,qualityMetricCards,type QualityOverview} from '../public/quality.mjs';
// ATS-215: the EVIDENCE WORKBENCH module. The SAME module the portable UI
// imports, so the two interfaces locate a trace the same way and cannot
// drift apart.
import {buildWorkbench,formatBytes as ebFormatBytes,formatTime as ebFormatTime,shortDigest,kindLabel,type WorkbenchView} from '../public/evidence-workbench.mjs';
const Monaco=dynamic(()=>import('@monaco-editor/react'),{ssr:false});
type Tab='catalog'|'runs'|'quality'|'evidence'|'trace'|'security'|'architecture';
const label:Record<string,string>={passed:'通过',failed:'失败',running:'运行中',queued:'排队中',cancelling:'停止中',cancelled:'已停止',interrupted:'中断',error:'错误'};
// ATS-216: the labels of the buckets the overview distinguishes. A CANCELLED
// run and a FLAKY case get their own words -- they are not "失败" and they
// are not "通过".
const bucketLabel:Record<string,string>={passed:'通过',failed:'失败',flaky:'重试后通过',skipped:'跳过',unknown:'未知',cancelled:'已取消',error:'启动失败',interrupted:'被中断',inFlight:'进行中'};
// The run buckets of the overview. `unknown` holds the runs whose status
// the module does not know -- a fact it does not have, so it goes into the
// bucket that claims nothing.
const runBucketLabel:Record<string,string>={passed:'通过',failed:'失败',cancelled:'已取消',error:'启动失败',interrupted:'被中断',unknown:'未知状态',inFlight:'进行中'};
// ATS-213: the CREDENTIAL STATUS labels. The three statuses are mutually
// exclusive and each one gets its OWN word -- a status that is only
// signalled by colour is not a status a reader can act on
// (docs/05-UI-UX.md §4). The reason codes are shown too: "取不到" and
// "没配置" need different actions, and collapsing them into one word would
// hide that difference.
const credStatusLabel:Record<string,string>={configured:'已配置',['not-configured']:'未配置',unavailable:'取不到'};
const credStatusReason:Record<string,string>={CREDENTIAL_FOUND:'已从系统凭据库取回',CREDENTIAL_NOT_FOUND:'系统凭据库里没有这一条',CREDENTIAL_STORE_UNAVAILABLE:'本机系统凭据库不可用',CREDENTIAL_STORE_FAILED:'读取系统凭据库时失败'};
function formatTime(s?:string|null){return s?new Date(s).toLocaleString('zh-CN',{hour12:false}):'—'}
// ATS-111: the STATE PANEL.
//
// The four states are rendered by ONE component, so the four cannot drift
// apart: the same words, the same icon, the same affordance, wherever the
// state appears. A state is never signalled by colour alone
// (docs/05-UI-UX.md §4): every panel carries a LABEL, a DETAIL sentence
// and a HINT about what the reader can do next.
//
// The live region is what tells a screen reader that the state CHANGED --
// a failure is announced assertively, the other three politely.
function StatePanel({kind,detail,onRetry,retryLabel}:{kind:WorkbenchStateKind,detail?:string,onRetry?:()=>void,retryLabel?:string}){
 const s=WORKBENCH_STATES[kind];
 const Icon=kind==='loading'?Loader2:kind==='error'?TriangleAlert:kind==='cancelled'?Inbox:Inbox;
 return <div className={'state-panel state-'+kind} role={s.role} aria-live={s.ariaLive} aria-busy={s.busy?'true':'false'} data-state={kind} data-state-token={s.token}>
  <div className="state-head"><Icon size={16} className={kind==='loading'?'spin':''} aria-hidden="true"/><b>{s.label}</b></div>
  <p className="state-detail">{detail||s.detail}</p>
  <p className="state-hint">{s.hint}</p>
  {onRetry&&<button className="btn secondary small state-retry" onClick={onRetry}><RefreshCcw size={13}/> {retryLabel||'重试'}</button>}
 </div>;
}
function stepsOf(src:string){const arr:{line:number,name:string,kind:string}[]=[];src.split('\n').forEach((line,i)=>{
 const kind=/\bexpect\s*\(/.test(line)?'断言':/\.goto\s*\(/.test(line)?'导航':/\.fill\s*\(/.test(line)?'输入':/\.click\s*\(/.test(line)?'点击':/test\.step\s*\(/.test(line)?'步骤组':null;
 if(kind)arr.push({line:i+1,name:line.trim().slice(0,94),kind});
 });return arr;}
export default function Studio(){
 const [projects,setProjects]=useState<Project[]>([]),[active,setActive]=useState(''),[catalog,setCatalog]=useState<TestCatalog>({tests:[],files:[],warning:'',uidVersion:0,projectUid:''});
 const [runs,setRuns]=useState<Run[]>([]),[runDetail,setRunDetail]=useState<Run|null>(null),[selected,setSelected]=useState<TestDef|null>(null);
 const [source,setSource]=useState<Source|null>(null),[draft,setDraft]=useState(''),[view,setView]=useState<'graph'|'code'>('graph');
 const [tab,setTab]=useState<Tab>('catalog'),[filter,setFilter]=useState(''),[projectPath,setProjectPath]=useState('');
 const [dialog,setDialog]=useState(false),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [secContract,setSecContract]=useState<SecurityContract|null>(null),[credentials,setCredentials]=useState<CredentialRef[]>([]);
 // ATS-213: the AVAILABILITY STATUS of every stored credential. It is a
 // SEPARATE fetch from the reference list, because it is a different fact:
 // the list says "this machine remembers this reference", the status says
 // "the secret can be fetched right now". `credStatusError` keeps the
 // failure of that fetch -- a status that could not be measured must NOT be
 // rendered as "not configured", because that would claim a fact nobody
 // measured.
 const [credStatuses,setCredStatuses]=useState<CredentialStatus[]>([]),[credStatusError,setCredStatusError]=useState('');
 const [consents,setConsents]=useState<EgressConsent[]>([]),[preview,setPreview]=useState<EgressPreview|null>(null);
 const [audit,setAudit]=useState<EgressAuditRecord[]>([]);
 const [keyName,setKeyName]=useState(''),[keySecret,setKeySecret]=useState('');
 // ATS-111: the LOAD STATE of the catalogue panel. The four states are
 // named and distinguishable; `catalogueRequest` is the raw outcome and
 // the MODEL (apps/studio/lib/workbench-state.mjs) decides which of the
 // four it is. `catalogueAbort` is the handle that lets Escape cancel a
 // load that is still in flight -- a cancellation is its OWN state, not
 // a failure and not an empty list.
 const [catalogueRequest,setCatalogueRequest]=useState<{phase:'idle'|'pending'|'settled'|'failed'|'cancelled',itemCount?:number,error?:string}>({phase:'idle'});
 // The abort handle is a REF, not state. A function passed to a state
 // setter is the state's UPDATER: React CALLS it, so `setAbort(fn)`
 // would have invoked `fn` -- aborting the request the instant it was
 // made, and storing `undefined` as the new state. The handle is not
 // state (it never changes what is rendered), so a ref is the right
 // home for it.
 const catalogueAbort=React.useRef<(()=>void)|null>(null);
 // ATS-111: the load state of the RUN LIST. The run list is polled, so it
 // has its own failure mode: a poll that fails must not be confused with
 // "this project has no runs".
 const [runsRequest,setRunsRequest]=useState<{phase:'idle'|'pending'|'settled'|'failed',itemCount?:number,error?:string}>({phase:'idle'});
 const [lineage,setLineage]=useState<{requirements:{uid:string,title:string,status?:string}[],links:{from:string,to:string,type?:string}[]}>({requirements:[],links:[]});
 // ATS-216: the scope of the quality overview. `project` is the default;
 // `all` spans every project, `run` is a single run.
 const [qualityScope,setQualityScope]=useState<'project'|'all'|'run'>('project'),[qualityRunId,setQualityRunId]=useState('');
 // ATS-215: the evidence workbench. `evidenceRunId` is the run whose
 // evidence is on the screen; `evidenceMaterial` is the FACTS the bridge
 // hands over, and the VIEW is computed by the shared module -- the same
 // module the portable UI imports.
 const [evidenceRunId,setEvidenceRunId]=useState(''),[evidenceMaterial,setEvidenceMaterial]=useState<EvidenceMaterial|null>(null),[evidenceSelected,setEvidenceSelected]=useState(0);
 const notify=(s:string)=>{setMessage(s);setTimeout(()=>setMessage(''),5500)};
 const refresh=useCallback(async()=>{try{
  setRunsRequest(r=>r.phase==='idle'?{phase:'pending'}:r);
  const [p,r]=await Promise.all([api<{projects:Project[]}>('/api/projects'),api<{runs:Run[]}>('/api/runs')]);setProjects(p.projects);setRuns(r.runs);
  setRunsRequest({phase:'settled',itemCount:r.runs.length});
  if(!active&&p.projects.length)setActive(p.projects[0].id);
 }catch(e){setRunsRequest({phase:'failed',error:(e as Error).message});notify((e as Error).message)}},[active]);
 useEffect(()=>{refresh();const t=setInterval(()=>{api<{runs:Run[]}>('/api/runs').then(r=>setRuns(r.runs)).catch(()=>{})},1800);return()=>clearInterval(t)},[refresh]);
 // ATS-111: the catalogue load is CANCELLABLE and reports its outcome.
 //
 // The request is aborted when the project changes, so the answer of the
 // project the reader left can never land on the project they are now
 // looking at -- and the reader is told the load was CANCELLED rather
 // than being left with a spinner that never resolves.
 useEffect(()=>{
  if(!active){setCatalog({tests:[],files:[],warning:'',uidVersion:0,projectUid:''});
   setCatalogueRequest({phase:'idle'});return;}
  let cancelled=false;
  setCatalogueRequest({phase:'pending'});
  const controller=cancellableApi<TestCatalog>(`/api/projects/${active}/tests`);
  catalogueAbort.current=controller.abort;
  controller.promise.then(c=>{if(cancelled)return;setCatalog(c);setCatalogueRequest({phase:'settled',itemCount:c.tests.length});})
   .catch(e=>{if(cancelled||controller.cancelled())return;
    setCatalogueRequest({phase:'failed',error:(e as Error).message});notify((e as Error).message);});
  api<typeof lineage>(`/api/projects/${active}/lineage`).then(setLineage).catch(()=>setLineage({requirements:[],links:[]}));
  setSelected(null);setSource(null);
  return()=>{cancelled=true;controller.abort();catalogueAbort.current=null;};
 },[active]);
 // ATS-111: Escape cancels the load that is in flight. The cancellation
 // is a state of its own, so the reader can tell it apart from a failure
 // and from an empty list.
 const cancelCatalogue=useCallback(()=>{
  if(catalogueRequest.phase!=='pending')return false;
  catalogueAbort.current?.();catalogueAbort.current=null;
  setCatalogueRequest({phase:'cancelled'});return true;
 },[catalogueRequest.phase]);
 const selectedProject=projects.find(p=>p.id===active),projectRuns=runs.filter(r=>r.projectId===active),live=projectRuns.find(r=>['running','queued','cancelling'].includes(r.status));
 const shown=catalog.tests.filter(t=>`${t.file} ${t.title}`.toLowerCase().includes(filter.toLowerCase()));
 const stats={passed:projectRuns.filter(r=>r.status==='passed').length,failed:projectRuns.filter(r=>r.status==='failed').length,total:projectRuns.length};
 const currentRun=runDetail && runDetail.projectId===active ? runDetail : projectRuns[0];
 useEffect(()=>{if(currentRun?.id&&tab==='runs')api<{run:Run}>(`/api/runs/${currentRun.id}`).then(r=>setRunDetail(r.run)).catch(()=>{});},[runs,tab,currentRun?.id]);
 const loadSecurity=useCallback(async()=>{try{
  const [c,k,g,a]=await Promise.all([
   api<SecurityContract>('/api/security/contract'),
   api<{credentials:CredentialRef[]}>('/api/security/credentials'),
   api<{consents:EgressConsent[]}>('/api/security/egress/consents'),
   api<{audit:EgressAuditRecord[]}>('/api/security/egress/audit')]);
  setSecContract(c);setCredentials(k.credentials);setConsents(g.consents);setAudit(a.audit);
 }catch(e){notify((e as Error).message)}
 // ATS-213: the STATUS fetch is SEPARATE from the list fetch. If it fails,
 // the references are still shown, and the panel says the STATUS could not
 // be read. Reporting "未配置" for a status nobody measured would be a
 // fabricated fact -- the worst outcome a status surface can have.
 try{
  const s=await api<{statuses:CredentialStatus[]}>('/api/security/credentials/status');
  setCredStatuses(s.statuses);setCredStatusError('');
 }catch(e){setCredStatusError((e as Error).message);}
 },[]);
 useEffect(()=>{if(tab==='security')loadSecurity();},[tab,loadSecurity]);
 async function openFile(test:TestDef){setSelected(test);try{const s=await api<Source>(`/api/projects/${active}/source?file=${encodeURIComponent(test.file)}`);setSource(s);setDraft(s.content)}catch(e){notify((e as Error).message)}}
 async function addProject(){setBusy(true);try{const r=await api<{project:Project}>('/api/projects','POST',{path:projectPath});setDialog(false);setProjectPath('');setActive(r.project.id);await refresh();notify('项目添加成功：未修改原仓库')}catch(e){notify((e as Error).message)}finally{setBusy(false)}}
 async function execute(file:string|null){if(!active)return;try{const {run}=await api<{run:Run}>(`/api/projects/${active}/run`,'POST',{file});setRunDetail(run);setTab('runs');await refresh();notify('已提交到本地 Playwright Runner')}catch(e){notify((e as Error).message)}}
 async function save(){if(!selected||!source)return;try{const r=await api<{hash:string}>(`/api/projects/${active}/source`,'PUT',{file:selected.file,content:draft,baseHash:source.hash});setSource({...source,content:draft,hash:r.hash});notify('已保存至原仓库工作区，未自动 Git commit')}catch(e){notify((e as Error).message)}}
 const steps=useMemo(()=>stepsOf(draft),[draft]);
 // ATS-216: the quality overview. The scope decides WHICH runs are walked:
 // the runs of the current project, every run, or one run. The module does
 // the counting and the reconciliation; this only chooses the input.
 const qualityRuns=useMemo(()=>{
  if(qualityScope==='all')return runs;
  if(qualityScope==='run')return qualityRunId?runs.filter(r=>r.id===qualityRunId):[];
  return projectRuns;
 },[runs,projectRuns,qualityScope,qualityRunId]);
 const overview:QualityOverview=useMemo(()=>buildQualityOverview(qualityRuns),[qualityRuns]);
 // ATS-216: the metric cards come from the SHARED module, so the Next
 // workbench and the portable UI show the same numbers -- and every card
 // carries the raw items it was counted from.
 const qualityCards=useMemo(()=>qualityMetricCards(overview),[overview]);
 // --- ATS-402: the AI data security actions --------------------------------
 // The secret is sent once to the credential store and then CLEARED from the
 // local state, so it is not left in the component's memory.
 async function saveKey(){if(!keyName||!keySecret)return;setBusy(true);
  try{await api<{credential:CredentialRef}>('/api/security/credentials','POST',{name:keyName,secret:keySecret,purpose:'ai-provider'});
   setKeySecret('');await loadSecurity();notify('密钥已存入系统凭据库，本地仅保留引用');
  }catch(e){notify((e as Error).message)}finally{setBusy(false)}}
 async function removeKey(id:string){try{await api(`/api/security/credentials/${id}`,'DELETE');await loadSecurity();notify('已删除凭据库中的密钥')}catch(e){notify((e as Error).message)}}
 async function previewEgress(){if(!active)return notify('请先选择项目');
  const inputs=catalog.tests.length?[{kind:'file',ref:catalog.tests[0].file}]:[];
  if(!inputs.length)return notify('该项目没有可预览的测试文件');
  try{const r=await api<{preview:EgressPreview}>('/api/security/egress/preview','POST',{projectId:active,inputs});setPreview(r.preview)}
  catch(e){notify((e as Error).message)}}
 async function confirmEgress(){if(!preview||!active)return;setBusy(true);
  try{const inputs=preview.scope.items.map(i=>({kind:i.kind,ref:i.ref}));
   await api<{consent:EgressConsent}>('/api/security/egress/confirm','POST',{projectId:active,inputs,previewId:preview.previewId});
   setPreview(null);await loadSecurity();notify('已记录知情授权');
  }catch(e){notify((e as Error).message)}finally{setBusy(false)}}
 async function revokeConsent(id:string){try{await api(`/api/security/egress/consents/${id}`,'DELETE');await loadSecurity();notify('授权已撤销，立即生效')}catch(e){notify((e as Error).message)}}
 // ATS-111: the CORE FLOW IS COMPLETABLE WITH THE KEYBOARD.
 //
 // The four commands the workbench binds are declared in the model
 // (apps/studio/lib/workbench-state.mjs), and this handler routes the
 // key event to them:
 //
 //   Escape        cancels what is in flight (the catalogue load, the
 //                  open dialog) -- and says so, instead of leaving a
 //                  spinner that never resolves;
 //   Enter         submits what is on screen (the project dialog, the
 //                  credential form);
 //   Ctrl+Enter    runs the case that is selected;
 //   Ctrl+P        moves the focus to the script search.
 //
 // A plain Enter inside a TEXT FIELD is left to the browser (it is the
 // field's own "submit" behaviour), so typing a path and pressing Enter
 // still submits the form.
 const searchRef=React.useRef<HTMLInputElement|null>(null);
 const runCurrent=useCallback(async()=>{
  if(!active)return;if(live)return;
  await execute(selected?.file??null);
 },[active,live,selected?.file]);
 const onWorkbenchKey=useCallback((e:React.KeyboardEvent)=>{
  const command=keyCommandFor(e.nativeEvent);
  if(!command)return;
  if(command==='cancel'){
   // The dialog is the innermost thing that can be cancelled.
   if(dialog){setDialog(false);e.preventDefault();return;}
   if(cancelCatalogue()){e.preventDefault();return;}
   return;
  }
  if(command==='focus-search'){searchRef.current?.focus();e.preventDefault();return;}
  if(command==='run-current'){void runCurrent();e.preventDefault();return;}
  if(command==='submit'){
   // A text field keeps its own Enter behaviour.
   if(isTextEntry(e.target))return;
   if(dialog&&projectPath){void addProject();e.preventDefault();return;}
   if(tab==='security'&&keyName&&keySecret){void saveKey();e.preventDefault();return;}
   if(selected&&source&&draft!==source.content){void save();e.preventDefault();return;}
  }
 },[dialog,projectPath,tab,keyName,keySecret,selected,source,draft,cancelCatalogue,runCurrent]);
 // ATS-111: the state of the catalogue panel, decided by the MODEL.
 // The panel component renders the ARIA attributes itself, from the same
 // model, so there is no second copy of them here to drift.
 const catalogueState=deriveWorkbenchState(catalogueRequest);
 // ATS-215: the EVIDENCE WORKBENCH. The view is computed by the SHARED
 // module, so the Next workbench and the portable UI locate a trace the
 // same way -- there is one implementation, not two.
 const evidenceView:WorkbenchView|null=useMemo(()=>{
  if(!evidenceMaterial)return null;
  return buildWorkbench(evidenceMaterial.run,evidenceMaterial.artifacts,evidenceMaterial.cases,{verification:evidenceMaterial.verification??undefined});
 },[evidenceMaterial]);
 // The workbench follows the runs of the current project; the selected
 // run is the first one that has evidence.
 useEffect(()=>{if(tab!=='evidence')return;
  if(!evidenceRunId&&projectRuns.length)setEvidenceRunId(projectRuns[0].id);
 },[tab,projectRuns,evidenceRunId]);
 useEffect(()=>{if(tab!=='evidence'||!evidenceRunId)return;
  let cancelled=false;
  api<EvidenceMaterial>(`/api/runs/${evidenceRunId}/workbench`).then(m=>{if(!cancelled){setEvidenceMaterial(m);setEvidenceSelected(0);}}).catch(e=>{if(!cancelled)notify((e as Error).message);});
  return()=>{cancelled=true;};
 },[tab,evidenceRunId]);
 // ATS-111: the workbench root carries the key handler, so the commands
 // work wherever the focus happens to be. The skip link is the first
 // focusable element: it lets a keyboard user jump straight to the
 // content instead of walking the rail.
 return <div className="app-shell" onKeyDown={onWorkbenchKey}>
  <a className="skip-link" href="#content">跳到主要内容</a>
  <aside className="rail" role="navigation" aria-label="主导航" data-region="rail"><div className="mark"><TestTube2 size={23}/></div>
   <button title="测试目录" aria-label="测试目录" aria-current={tab==='catalog'?'page':undefined} className={tab==='catalog'?'rail-btn active':'rail-btn'} onClick={()=>setTab('catalog')}><Layers3 size={20}/></button>
   <button title="执行中心" aria-label="执行中心" aria-current={tab==='runs'?'page':undefined} className={tab==='runs'?'rail-btn active':'rail-btn'} onClick={()=>setTab('runs')}><Activity size={20}/></button>
   <button title="质量概览" aria-label="质量概览" aria-current={tab==='quality'?'page':undefined} className={tab==='quality'?'rail-btn active':'rail-btn'} onClick={()=>setTab('quality')}><ChartNoAxesCombined size={20}/></button>
   <button title="证据工作台" aria-label="证据工作台" aria-current={tab==='evidence'?'page':undefined} className={tab==='evidence'?'rail-btn active':'rail-btn'} onClick={()=>setTab('evidence')}><FolderGit2 size={20}/></button>
   <button title="需求追踪" aria-label="需求追踪" aria-current={tab==='trace'?'page':undefined} className={tab==='trace'?'rail-btn active':'rail-btn'} onClick={()=>setTab('trace')}><Network size={20}/></button>
   <button title="AI 数据安全" aria-label="AI 数据安全" aria-current={tab==='security'?'page':undefined} className={tab==='security'?'rail-btn active':'rail-btn'} onClick={()=>setTab('security')}><Lock size={20}/></button>
   <button title="架构和限制" aria-label="架构和限制" aria-current={tab==='architecture'?'page':undefined} className={tab==='architecture'?'rail-btn active':'rail-btn'} onClick={()=>setTab('architecture')}><Box size={20}/></button>
   <div className="rail-bottom"><span className="live-dot"/></div>
  </aside>
  <div className="main-column">
   <header className="topbar"><div className="brand">AI Test <span>Studio</span><small>LOCAL · 0.1.0</small></div>
    <div className="top-actions"><span className="chip subdued"><ShieldAlert size={13}/> 本地可信仓库模式</span><button className="icon-btn" onClick={()=>refresh()} title="刷新" aria-label="刷新" data-region="refresh"><RefreshCcw size={16}/></button></div></header>
   <section className="projectbar" aria-label="工作区"><div><span className="eyebrow">WORKSPACE</span><select value={active} onChange={e=>setActive(e.target.value)} className="project-select" aria-label="选择测试项目" data-region="project-select"><option value="">选择测试项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
    {selectedProject&&<div className="repo-meta"><span><GitBranch size={14}/>{selectedProject.git.branch}</span><span><GitCommitHorizontal size={14}/>{selectedProject.git.commit}</span>{selectedProject.git.dirty&&<span className="dirty">未提交修改</span>}</div>}
    <button className="btn secondary" onClick={()=>setDialog(true)} data-region="add-project"><FilePlus2 size={15}/> 添加项目</button>
   </section>
   <section className="workspace">
    <aside className="sidebar" aria-label="资源列表" data-region="sidebar"><div className="sidebar-head"><div className="eyebrow">EXPLORER</div><h3>{tab==='catalog'?'测试资产':tab==='runs'?'运行记录':tab==='quality'?'质量概览':tab==='evidence'?'证据工作台':tab==='trace'?'需求列表':'模块概览'}</h3></div>
     {tab==='catalog'&&<><div className="search" role="search" data-region="search"><Search size={15}/><input ref={searchRef} placeholder="查找脚本或测试用例" aria-label="查找脚本或测试用例" value={filter} onChange={e=>setFilter(e.target.value)}/></div>
     {/* ATS-111: the four states of the catalogue panel. Only ONE of them
         is shown at a time, and each says something different: the list
         is empty, the load failed, the load was cancelled, or the load is
         still running. */}
     <div className="file-list" data-region="panel" data-catalogue-state={catalogueState||'ready'}>
     {catalogueState==='loading'&&<StatePanel kind="loading"/>}
     {catalogueState==='error'&&<StatePanel kind="error" detail={catalogueRequest.error?`原因：${catalogueRequest.error}`:undefined} onRetry={()=>setActive(a=>a)} retryLabel="重新加载"/>}
     {catalogueState==='cancelled'&&<StatePanel kind="cancelled" onRetry={()=>setActive(a=>a)} retryLabel="重新加载"/>}
     {catalogueState==='empty'&&<StatePanel kind="empty" detail="这个项目里没有可执行的测试用例。" onRetry={()=>setActive(a=>a)} retryLabel="重新加载"/>}
     {shown.map(t=><button key={t.id} className={'file-item '+(selected?.id===t.id?'selected':'')} onClick={()=>openFile(t)}><FileCode2 size={16}/><span><b>{t.title}</b><small>{t.file}:{t.line}</small><small className="uid-tag">{t.uid}{t.uidStable?'':' ⚠'}</small></span><ChevronRight size={14}/></button>)}
     {/* The filter matched nothing -- a DIFFERENT fact from "the project has
         no cases at all", so it is a different message. */}
     {!catalogueState&&!shown.length&&<div className="empty-small">没有匹配「{filter}」的用例<br/>清空筛选条件可查看全部</div>}
     </div></>}
     {tab==='runs'&&<div className="file-list" data-region="runs-panel" data-runs-state={runsRequest.phase==='failed'?'error':runsRequest.phase==='pending'&&!runs.length?'loading':!projectRuns.length?'empty':'ready'}>
     {runsRequest.phase==='failed'&&<StatePanel kind="error" detail={runsRequest.error?`原因：${runsRequest.error}`:undefined} onRetry={()=>refresh()} retryLabel="重新加载"/>}
     {runsRequest.phase==='pending'&&!runs.length&&<StatePanel kind="loading"/>}
     {runsRequest.phase==='settled'&&!projectRuns.length&&<StatePanel kind="empty" detail="这个项目还没有运行记录。"/>}
     {projectRuns.map(r=><button className={'run-item '+(currentRun?.id===r.id?'selected':'')} key={r.id} onClick={()=>setRunDetail(r)}><span className={'status-dot '+r.status}/><span><b>{r.file||'全部测试'}</b><small>{formatTime(r.createdAt)}</small><small className="uid-tag">{r.uid}</small></span><small>{label[r.status]||r.status}</small></button>)}</div>}
     {tab==='quality'&&<><div className="search" style={{padding:'0 12px 10px'}}><select value={qualityScope} onChange={e=>{setQualityScope(e.target.value as 'project'|'all'|'run');if(e.target.value==='run'&&!qualityRunId)setQualityRunId(projectRuns[0]?.id||'');}} className="project-select" style={{fontSize:13,minWidth:0,width:'100%'}}><option value="project">当前项目</option><option value="all">全部项目</option><option value="run">单次运行</option></select></div>
     {qualityScope==='run'&&<div className="file-list">{projectRuns.map(r=><button key={r.id} className={'run-item '+(qualityRunId===r.id?'selected':'')} onClick={()=>setQualityRunId(r.id)}><span className={'status-dot '+r.status}/><span><b>{r.file||'全部测试'}</b><small>{formatTime(r.createdAt)}</small></span><small>{label[r.status]||r.status}</small></button>)}</div>}
     <div className="sidebar-hint">失败、重试与取消分开计数。质量概览页的「原始结果」列出每个数字的来源用例与 attempt。</div></> }
     {/* ATS-215: the evidence workbench's explorer. The FAILURE list is
         here on purpose: the acceptance criterion is that the trace is
         reachable from a failing case within two clicks, so the failing
         case and the trace button must be on the same screen. */}
     {tab==='evidence'&&<><div className="search" style={{padding:'0 12px 10px'}}><select value={evidenceRunId} onChange={e=>setEvidenceRunId(e.target.value)} className="project-select" style={{fontSize:13,minWidth:0,width:'100%'}}><option value="">选择运行</option>{projectRuns.map(r=><option key={r.id} value={r.id}>{label[r.status]||r.status} · {r.file||'全部测试'} · {formatTime(r.createdAt)}</option>)}</select></div>
     <div className="file-list">{(evidenceView?.failures??[]).map((f,i)=><button key={i} className={'file-item '+(evidenceSelected===i?'selected':'')} onClick={()=>setEvidenceSelected(i)}><XCircle size={16}/><span><b>{f.title}</b><small>{f.file}{f.line?':'+f.line:''}</small><small className="uid-tag">{f.traceLocated?`${f.clickPath.clicks} 次点击可达 Trace`:f.traceReason}</small></span><ChevronRight size={14}/></button>)}{!(evidenceView?.failures??[]).length&&<div className="empty-small">该运行没有失败用例<br/>选择另一次运行查看证据</div>}</div>
     <div className="sidebar-hint">失败用例 → 点击 Trace，2 次点击内可达。附件显示归档时的 SHA-256 与文件时间。</div></>}
     {tab==='trace'&&<div className="file-list">{lineage.requirements.map(r=><div key={r.uid} className="file-item"><BookOpen size={16}/><span><b>{r.title}</b><small>{r.uid}</small></span></div>)}{!lineage.requirements.length&&<div className="empty-small">项目 .aitest/requirements.json<br/>可加载需求与关联关系</div>}</div>}
     {tab==='security'&&<div className="sidebar-hint">密钥存系统凭据库；外传前先展示范围并确认。</div>}
     {tab==='architecture'&&<div className="sidebar-hint">Git 是唯一脚本来源；SQLite 和远程执行留到后续迭代。v0.1 存储为本地 JSON。</div>}
     <div className="sidebar-footer">{catalog.tests.length} tests · {catalog.files.length} files<br/><span>{selectedProject?.root||'未连接 Git 项目'}</span></div>
    </aside>
    <main className="content" id="content" role="main" tabIndex={-1} aria-label="工作区内容" data-region="content">
     {tab==='catalog'&&<><div className="section-top"><div><div className="eyebrow">TEST CATALOG / SOURCE OF TRUTH</div><h1>{selected?.title||'测试目录与脚本工作台'}</h1><p>{selected?.file||'在左侧选择一个测试用例，查看可视化步骤与 TypeScript 原始脚本。'}</p></div><div className="button-group"><button className="btn secondary" onClick={()=>execute(null)} disabled={!active||!!live}><Play size={15}/> 运行全部</button><button className="btn primary" onClick={()=>execute(selected?.file||null)} disabled={!active||!!live}><Play size={15}/> {selected?'运行脚本':'执行测试'}</button></div></div>
     <div className="metric-row"><div className="metric"><span>可管理用例</span><strong>{catalog.tests.length}</strong><small>静态索引 · Git 原生</small></div><div className="metric"><span>成功运行</span><strong>{stats.passed}</strong><small>保留历史证据</small></div><div className="metric"><span>失败运行</span><strong>{stats.failed}</strong><small>可追踪与复现</small></div><div className="metric"><span>累计运行</span><strong>{stats.total}</strong><small>append-only execution</small></div></div>
     {selected&&source?<div className="editor-panel"><div className="panel-head"><div className="panel-tabs"><button className={view==='graph'?'active':''} onClick={()=>setView('graph')}><Network size={15}/> 流程视图</button><button className={view==='code'?'active':''} onClick={()=>setView('code')}><Code2 size={15}/> 代码视图</button></div><div className="panel-right"><span className="quiet">{draft!==source.content?'● 未保存':'已同步 Git 工作区'}</span><button className="btn small" onClick={()=>setView('code')}><Code2 size={13}/> 编辑</button><button className="btn primary small" onClick={save} disabled={draft===source.content}><Save size={13}/> 保存</button></div></div>
     {view==='graph'?<div className="graph-view"><div className="graph-label">READ ONLY · 语义投影，不覆盖复杂 TS</div>{steps.map((s,i)=><React.Fragment key={i}><div className="flow-node"><span className="step-n">{String(i+1).padStart(2,'0')}</span><div><small>{s.kind} · L{s.line}</small><code>{s.name}</code></div></div>{i<steps.length-1&&<div className="flow-line"/>}</React.Fragment>)}{!steps.length&&<div className="empty-small">此脚本包含复杂或不支持的表达式，请使用代码视图编辑。</div>}</div>:<div className="code-editor"><Monaco height="420px" language="typescript" theme="vs-dark" value={draft} onChange={v=>setDraft(v||'')} options={{minimap:{enabled:false},fontSize:13,wordWrap:'on',automaticLayout:true}}/></div>}
     <div className="panel-foot">当前阶段的流程图为只读投影；复杂 TypeScript 始终由源代码保持完整表达。编辑保存采用 SHA-256 乐观并发检查。</div></div>:<div className="welcome"><div className="welcome-icon"><FolderGit2 size={35}/></div><h2>从 Git 到可视化测试</h2><p>保留已有 Playwright 工程结构。选择项目与脚本后，可以查看步骤、编辑源码、运行用例并收集证据。</p><button className="btn primary" onClick={()=>setDialog(true)}>导入本地 Git 项目</button></div>}
     {catalog.warning&&<div className="note"><ShieldAlert size={15}/>{catalog.warning}</div>}</>}
     {tab==='runs'&&<><div className="section-top"><div><div className="eyebrow">EXECUTION CENTER</div><h1>执行中心</h1><p>保留每次运行的完整状态、错误日志与 Playwright 原始证据。</p></div>{live&&<button className="btn danger" onClick={async()=>{await api(`/api/runs/${live.id}/stop`,'POST');refresh()}}><Square size={14}/> 停止运行</button>}</div>
      {currentRun?<><div className="metric-row"><div className="metric"><span>当前运行</span><strong className="small-value">{label[currentRun.status]||currentRun.status}</strong><small>{currentRun.gitCommit}</small></div><div className="metric"><span>通过</span><strong>{currentRun.summary?.passed??'—'}</strong></div><div className="metric"><span>失败</span><strong>{currentRun.summary?.failed??'—'}</strong></div><div className="metric"><span>总用例</span><strong>{currentRun.summary?.total??'—'}</strong></div></div>
      <div className="split"><div className="card grow"><div className="card-title"><Terminal size={16}/> 实时输出与历史日志</div><pre className="console">{currentRun.log||currentRun.error||'正在等待执行输出…'}</pre></div><div className="card evidence"><div className="card-title"><Download size={16}/> 运行证据</div>{currentRun.artifacts?.length?currentRun.artifacts.map(a=><button key={a.file} className="artifact" onClick={()=>downloadArtifact(currentRun.id,a.file).catch(e=>notify(e.message))}><span>{a.file}</span><small>{Math.ceil(a.size/1024)} KB</small></button>):<p className="muted">测试完成后显示 JSON / HTML / trace.zip / 截图等原始附件。</p>}</div></div>
      {currentRun.summary?.cases?.length?<div className="card"><div className="card-title"><CheckCircle2 size={16}/> 详细结果</div>{currentRun.summary.cases.map((c,i)=><div key={i} className="result-item"><span className={c.status==='passed'?'ok':'bad'}>{c.status==='passed'?<CheckCircle2 size={16}/>:<XCircle size={16}/>}</span><div><b>{c.title}</b><small>{c.file} · {c.duration}ms · {c.attemptsCount} 次执行</small>{c.error&&<pre>{c.error.slice(0,450)}</pre>}</div></div>)}</div>:null}</>:<div className="welcome"><Activity size={32}/><h2>尚无运行记录</h2><p>从测试目录选择脚本并点击运行。</p></div>}</>}
     {tab==='quality'&&<><div className="section-top"><div><div className="eyebrow">QUALITY OVERVIEW</div><h1>质量概览</h1><p>失败、重试与取消分开计数；每个指标都能核对到原始用例与 attempt。</p></div><div className="button-group"><button className="btn secondary" onClick={()=>refresh()}><RefreshCcw size={15}/> 刷新</button></div></div>
      <div className="metric-row">{qualityCards.map(c=><div className="metric" key={c.key}><span>{c.label}</span><strong>{c.value}</strong><small>{c.subtitle}</small></div>)}</div>
      <div className="card"><div className="card-title"><ChartNoAxesCombined size={16}/> 指标与原始结果核对</div>
       <table><thead><tr><th>核对项</th><th>期望（原始结果）</th><th>实得（指标）</th><th>结论</th></tr></thead><tbody>{overview.reconciliation.checks.map((c,i)=><tr key={i}><td>{c.name}</td><td>{c.expected}</td><td>{c.actual}</td><td className={c.ok?'ok':'bad'}>{c.ok?'一致':'不一致'}</td></tr>)}</tbody></table>
       {!overview.reconciliation.consistent&&<div className="note"><ShieldAlert size={15}/>指标与原始结果不一致。上表的“不一致”行指明了差异所在，请以原始结果为准。</div>}
       {overview.reconciliation.consistent&&<p className="muted">全部核对项一致：上述指标可以由原始用例与 attempt 复算得到。</p>}
      </div>
      <div className="card"><div className="card-title"><Layers3 size={16}/> 原始结果（每个数字的来源）</div>
       {qualityCards.map(c=><details key={c.key} style={{borderBottom:'1px solid var(--border)',padding:'11px 0'}}><summary style={{cursor:'pointer',fontSize:12}}>{c.label} {c.value} · {c.refs.length} 项原始结果</summary>
        {c.caseRefs.map((r,i)=><p key={i} style={{fontSize:11,color:'#8da5ba',margin:'5px 0'}}>用例 {r.title} · {r.file}{r.scope.length?' · '+r.scope.join(' / '):''}{r.line?':'+r.line:''} · {r.status} · {r.attemptsCount} 次 attempt（{r.attemptStatuses.join(', ')}）· 运行 {r.runId}{r.error?' · '+r.error.slice(0,90):''}</p>)}
        {c.runRefs.map((r,i)=><p key={i} style={{fontSize:11,color:'#8da5ba',margin:'5px 0'}}>运行 {r.id} · {r.status} · seq {r.seq??'—'}{r.gitCommit?' · '+r.gitCommit:''}</p>)}
        {!c.refs.length&&<p className="muted">没有原始结果。</p>}</details>)}
       <details style={{borderBottom:'1px solid var(--border)',padding:'11px 0'}}><summary style={{cursor:'pointer',fontSize:12}}>未出结论的用例 {overview.cases.inconclusive} 项</summary>
        {(overview.cases.inconclusiveRefs??[]).map((r,i)=><p key={i} style={{fontSize:11,color:'#8da5ba',margin:'5px 0'}}>用例 {r.title} · {r.file} · {r.status} · {r.attemptsCount} 次 attempt · 运行 {r.runId}（{r.runStatus}）</p>)}
        <p className="muted">未出结论的运行的 attempt：{overview.cases.inconclusiveAttempts??0} 次（不计入通过/失败/重试）。</p></details>
      </div>
      <div className="split"><div className="card grow"><div className="card-title"><Layers3 size={16}/> 失败聚类（非 AI）</div>{overview.clusters.length?overview.clusters.map(c=><div key={c.key} className="result-item"><span className="bad"><XCircle size={16}/></span><div><b>{c.kind} · {c.count} 次</b><small>{c.files.join('、')||'未知文件'}</small><pre>{c.signature}</pre></div></div>):<p className="muted">没有失败用例。相同签名（错误文本归一化后）的失败聚为一类。</p>}</div>
       <div className="card evidence"><div className="card-title"><Activity size={16}/> 重试与不稳定用例</div>{overview.tests.flaky?overview.tests.list.filter(t=>t.flaky).map(t=><div key={t.key} className="result-item"><span className="bad"><RefreshCcw size={16}/></span><div><b>{t.title}</b><small>{t.file} · {t.runs} 次运行 · 失败 {t.failedRuns} / 重试 {t.flakyRuns} / 通过 {t.passedRuns}</small></div></div>):<p className="muted">没有重试过或时好时坏的用例。</p>}</div></div>
      <div className="card"><div className="card-title"><Terminal size={16}/> 运行分布</div><table><thead><tr><th>运行状态</th><th>数量</th><th>含义</th></tr></thead><tbody>{[['passed',overview.runs.passed],['failed',overview.runs.failed],['cancelled',overview.runs.cancelled],['error',overview.runs.error],['interrupted',overview.runs.interrupted],['unknown',overview.runs.unknown],['inFlight',overview.runs.inFlight]].map(([k,v])=><tr key={String(k)}><td>{runBucketLabel[String(k)]||bucketLabel[String(k)]||String(k)}</td><td>{String(v)}</td><td>{k==='inFlight'?'尚未结束，不计入任何比率':['passed','failed'].includes(String(k))?'计入运行通过率':'未得出结论，不计入失败'}</td></tr>)}</tbody></table></div>
     </>}
     {tab==='evidence'&&<><div className="section-top"><div><div className="eyebrow">EVIDENCE WORKBENCH</div><h1>证据工作台</h1><p>从失败用例 2 次点击内找到 Trace；附件显示归档时的 SHA-256 与文件时间。</p></div><div className="button-group"><button className="btn secondary" onClick={()=>{if(evidenceRunId)api<EvidenceMaterial>(`/api/runs/${evidenceRunId}/workbench`).then(setEvidenceMaterial).catch(e=>notify((e as Error).message));}}><RefreshCcw size={15}/> 刷新</button></div></div>
      {!evidenceView?<div className="welcome"><Activity size={32}/><h2>尚无证据</h2><p>选择一次已有证据的运行，查看失败用例的 Trace、附件哈希与时间。</p></div>:<>
      <div className="metric-row"><div className="metric"><span>失败用例</span><strong>{evidenceView.failureCount}</strong><small>定位到 Trace {evidenceView.totals.locatedTraces} 个</small></div><div className="metric"><span>证据文件</span><strong>{evidenceView.totals.count}</strong><small>{ebFormatBytes(evidenceView.totals.bytes)}</small></div><div className="metric"><span>点击预算</span><strong className="small-value">{evidenceView.clickBudget} 次</strong><small>失败用例 → Trace</small></div><div className="metric"><span>归档校验</span><strong className="small-value">{evidenceView.verification?(evidenceView.verification.verified?'一致':'不一致'):'未校验'}</strong><small>{evidenceView.verification?`${evidenceView.verification.checked} 个文件`:'无清单'}</small></div></div>
      {evidenceView.verification&&!evidenceView.verification.verified&&<div className="note"><ShieldAlert size={15}/>证据与清单不一致：{evidenceView.verification.missing.length?`缺失 ${evidenceView.verification.missing.length} 个`:''}{evidenceView.verification.changed.length?` 改动 ${evidenceView.verification.changed.length} 个`:''}。请以磁盘上的文件为准。</div>}
      {evidenceView.failures.length?<div className="card"><div className="card-title"><FolderGit2 size={16}/> 失败用例与 Trace（{evidenceView.failures.length}）</div>
       <table><thead><tr><th>用例</th><th>状态</th><th>Trace</th><th>哈希（归档）</th><th>时间</th><th>操作</th></tr></thead><tbody>
        {evidenceView.failures.map((f,i)=><tr key={i} className={evidenceSelected===i?'selected-row':''} onClick={()=>setEvidenceSelected(i)}>
         <td><b>{f.title}</b><br/><small className="muted">{f.file}{f.line?':'+f.line:''}</small></td>
         <td><span className={f.status==='failed'?'bad':'warn'}>{f.status}</span></td>
         <td>{f.trace?<><code className="mono">{f.trace.file}</code><br/><small className="muted">{ebFormatBytes(f.trace.size)}</small></>:<span className="bad">{f.traceReason}</span>}</td>
         <td>{f.trace?.sha256?<><code className="mono" title={f.trace.sha256}>{shortDigest(f.trace.sha256)}</code><br/><small className="muted" title={f.trace.sha256}>完整摘要见 title</small></>:'—'}</td>
         <td><small>{ebFormatTime(f.trace?.modifiedAt??null)}</small></td>
         <td>{f.trace?<button className="btn primary small" onClick={e=>{e.stopPropagation();downloadArtifact(evidenceRunId,f.trace!.file).catch(err2=>notify((err2 as Error).message));}}><Download size={13}/> 下载 Trace</button>:<span className="muted">无 Trace</span>}</td>
        </tr>)}
       </tbody></table>
       <div className="panel-foot">点击路径：{(evidenceView.failures[evidenceSelected]?.clickPath.steps??[]).map((s,i)=><span key={i}>{i?' → ':''}{s.label}</span>)} · 共 {(evidenceView.failures[evidenceSelected]?.clickPath.clicks??0)} 次点击（预算 {evidenceView.clickBudget} 次）</div>
      </div>:<div className="welcome"><CheckCircle2 size={32}/><h2>该运行没有失败用例</h2><p>证据清单仍然完整可查，见下方附件列表。</p></div>}
      {evidenceView.failures[evidenceSelected]?.attachments.length?<div className="card"><div className="card-title"><Download size={16}/> 选中用例的附件</div>
       <table><thead><tr><th>文件</th><th>类型</th><th>大小</th><th>SHA-256</th><th>时间</th></tr></thead><tbody>
        {evidenceView.failures[evidenceSelected].attachments.map(a=><tr key={a.file}><td><code className="mono">{a.file}</code></td><td>{kindLabel((a as {kind?:string}).kind??'')}</td><td>{ebFormatBytes(a.size)}</td><td><code className="mono" title={a.sha256??''}>{shortDigest(a.sha256)}</code></td><td><small>{ebFormatTime(a.modifiedAt)}</small></td></tr>)}
       </tbody></table>
       <div className="panel-foot">哈希是归档时清单记录的摘要（ATS-209），不是现在重算的摘要；上方的「归档校验」说明它是否仍与磁盘上的文件一致。</div>
      </div>:null}
      <div className="card"><div className="card-title"><Layers3 size={16}/> 本次运行的全部证据（{evidenceView.attachments.length}）</div>
       <table><thead><tr><th>文件</th><th>大小</th><th>SHA-256</th><th>时间</th></tr></thead><tbody>
        {evidenceView.attachments.map(a=><tr key={a.file}><td><code className="mono">{a.file}</code></td><td>{ebFormatBytes(a.size)}</td><td><code className="mono" title={a.sha256??''}>{shortDigest(a.sha256)}</code></td><td><small>{ebFormatTime(a.modifiedAt)}</small></td></tr>)}
       </tbody></table>
      </div>
      <div className="note"><ShieldAlert size={15}/>Trace Viewer 是独立的程序（npx playwright show-trace），其版本须与产生该 trace 的引擎一致{evidenceView.engineVersion?`（本次运行引擎版本 ${evidenceView.engineVersion}）`:'（本次运行未记录引擎版本）'}。本工作台只负责定位与校验，不代为打开 trace。</div>
      </>}</>}
     {tab==='trace'&&<><div className="section-top"><div><div className="eyebrow">QUALITY LINEAGE</div><h1>需求与测试追踪</h1><p>Requirement → Script → Execution → Evidence 的可查询映射。</p></div></div><div className="card"><div className="card-title"><Network size={17}/> 关联矩阵</div><table><thead><tr><th>需求编号</th><th>需求名称</th><th>关联用例</th><th>覆盖情况</th></tr></thead><tbody>{lineage.requirements.map(req=>{const targets=lineage.links.filter(x=>x.from===req.uid).map(x=>x.to);return <tr key={req.uid}><td>{req.uid}</td><td>{req.title}</td><td>{targets.join(', ')||'—'}</td><td>{targets.length?'已建立关联':'待补充'}</td></tr>})}</tbody></table>{!lineage.requirements.length&&<p className="muted">在项目中建立 .aitest/requirements.json 和 traceability.json 后可显示需求关系。</p>}</div></>}
     {tab==='security'&&<><div className="section-top"><div><div className="eyebrow">AI DATA SECURITY</div><h1>AI 数据安全</h1><p>密钥存入系统凭据库；任何项目内容外传前先展示范围并由你确认。</p></div><button className="btn secondary" onClick={loadSecurity}><RefreshCcw size={15}/> 刷新</button></div>
      <div className="metric-row"><div className="metric"><span>凭据库</span><strong className="small-value">{secContract?.provider||'不可用'}</strong><small>{secContract?'系统凭据库已就绪':'本机没有系统凭据库'}</small></div><div className="metric"><span>可用密钥</span><strong data-region="cred-configured-count">{credStatuses.filter(s=>s.status==='configured').length}</strong><small>共 {credentials.length} 条引用 · 本地只保留引用</small></div><div className="metric"><span>不可用密钥</span><strong data-region="cred-unavailable-count">{credStatuses.filter(s=>s.status!=='configured').length}</strong><small>{credStatuses.some(s=>s.status==='not-configured')?'未配置或取不到':'全部可用'}</small></div><div className="metric"><span>有效授权</span><strong>{consents.filter(c=>c.state==='granted').length}</strong><small>到期自动失效</small></div></div>
      <div className="split"><div className="card grow"><div className="card-title"><KeyRound size={16}/> 密钥存储</div>
       <p className="muted">密钥本体写入<b>系统凭据库</b>；本机索引只保留引用与指纹。没有任何接口会返回密钥原文。</p>
       <div className="panel-right" style={{justifyContent:'flex-start',gap:8,margin:'10px 0'}}><input placeholder="密钥名称" value={keyName} onChange={e=>setKeyName(e.target.value)}/><input placeholder="密钥内容" type="password" value={keySecret} onChange={e=>setKeySecret(e.target.value)}/><button className="btn primary small" onClick={saveKey} disabled={busy||!keyName||!keySecret}><Save size={13}/> 存入</button></div>
       {/* ATS-213: the STATUS column. Each stored credential carries exactly
           one status, measured against the OS credential store. The status is
           a WORD, not only a colour (docs/05-UI-UX.md §4), and the reason
           code is spelled out: "未配置" (re-enter the secret) and "取不到"
           (the store is unreachable) call for different actions. When the
           status could not be READ, the panel says so instead of guessing a
           status -- an unmeasured status rendered as "未配置" would be a
           fabricated fact. */}
       {credStatusError&&<div className="note" role="status" data-region="cred-status-error"><TriangleAlert size={15}/>可用状态读取失败：{credStatusError}（下方只列出引用，不代表密钥可用）</div>}
       {credStatuses.map(s=>{const tone=s.status==='configured'?'ok':'bad';
        return <div className="result-item" key={s.id} data-region="cred-status" data-cred-status={s.status}>
         <span className={tone}>{s.status==='configured'?<CheckCircle2 size={15}/>:<TriangleAlert size={15}/>}</span>
         <div><b>{s.name}</b><small>{s.provider} · 指纹 {s.fingerprint} · {s.purpose}</small>
          <small data-region="cred-status-label"><b className={tone}>{credStatusLabel[s.status]??s.status}</b> · {credStatusReason[s.reason]??s.reason} · 查于 {formatTime(s.checkedAt)}</small></div>
         <button className="btn danger small" onClick={()=>removeKey(s.id)}><Trash2 size={13}/> 删除</button></div>})}
       {!credStatuses.length&&!credStatusError&&<p className="muted">尚未存入任何密钥。</p>}
      </div>
      <div className="card evidence"><div className="card-title"><ShieldAlert size={16}/> 数据外传授权</div>
       <p className="muted">流程：<b>预览范围 → 确认 → 授权</b>。范围由平台侧读取真实文件并复算摘要，内容变了授权即失效。</p>
       <button className="btn secondary small" style={{margin:'10px 0'}} onClick={previewEgress}><FileSearch size={13}/> 预览将要外传的范围</button>
       {preview&&<div className="card" style={{marginTop:10}}><div className="card-title">待确认的范围</div><p className="muted">{preview.scope.count} 项 · {preview.scope.totalBytes} 字节 · 种类 {preview.scope.kinds.join('、')}</p>{preview.scope.items.map(i=><div className="result-item" key={i.ref}><span className="ok"><FileCode2 size={15}/></span><div><b>{i.ref}</b><small>{i.kind} · {i.bytes} 字节 · SHA-256 {i.digest.slice(0,16)}…</small></div></div>)}<button className="btn primary small" onClick={confirmEgress} disabled={busy}>确认并授权</button></div>}
       {consents.map(c=><div className="result-item" key={c.id}><span className={c.state==='granted'?'ok':'bad'}>{c.state==='granted'?<CheckCircle2 size={15}/>:<XCircle size={15}/>}</span><div><b>{c.kinds.join('、')} · {c.itemCount} 项</b><small>{c.state} · {c.expiresAt} 到期 · 摘要 {c.scopeDigest.slice(0,12)}…</small></div>{c.state==='granted'&&<button className="btn danger small" onClick={()=>revokeConsent(c.id)}><Trash2 size={13}/> 撤销</button>}</div>)}
       {!consents.length&&<p className="muted">尚无授权记录。</p>}
      </div></div>
      <div className="card"><div className="card-title"><ShieldAlert size={16}/> 外传审计</div>
       <p className="muted">每一次外传判定都会留痕，<b>放行与拒绝都记</b>。记录里只有 ref、字节数与 SHA-256 摘要——<b>不含内容、不含密钥</b>。</p>
       {audit.map(r=><div className="result-item" key={r.id}><span className={r.outcome==='allowed'?'ok':'bad'}>{r.outcome==='allowed'?<CheckCircle2 size={15}/>:<XCircle size={15}/>}</span><div><b>{r.event}</b><small>{formatTime(r.at)} · {r.kinds.join('、')||'—'} · {r.itemCount} 项 · {r.totalBytes} 字节{r.code?` · ${r.code}`:''}</small>{r.items.map((i,n)=><small key={`${i.ref}-${n}`} style={{display:'block'}}>{i.ref} · {i.digest?`SHA-256 ${i.digest.slice(0,12)}…`:'未读取内容'}</small>)}</div></div>)}
       {!audit.length&&<p className="muted">尚无外传记录。</p>}
      </div>
      <div className="note"><ShieldAlert size={15}/> 未接入模型提供商，因此当前没有任何请求能真正到达模型；本页交付的是凭据存储与外传授权这两道闸门本身。</div>
     </>}
     {tab==='architecture'&&<><div className="section-top"><div><div className="eyebrow">DESIGN BASELINE</div><h1>架构与运行边界</h1><p>Git-native · Evidence-driven · Visual-first</p></div></div><div className="architecture"><div className="arch-card"><FolderGit2/><h3>Git / Playwright</h3><p>已有仓库与测试代码是事实来源</p></div><div className="arch-card"><Activity/><h3>Node Runner Bridge</h3><p>本机子进程启动、停止、结果采集</p></div><div className="arch-card"><Clock/><h3>Execution History</h3><p>本地存储运行日志与不可变证据</p></div><div className="arch-card"><BookOpen/><h3>IPA Traceability</h3><p>需求、脚本与执行结果的映射入口</p></div></div><div className="note"><ShieldAlert size={15}/> 安全限制：仅用于可信的本地项目。Node 子进程不是容器沙箱。暂未加入远程执行、RBAC、密钥保险箱或 AI 自动写回。</div></>}
    </main>
   </section>
   <footer className="bottom-bar"><span><span className="online"/> LOCAL RUNNER · 127.0.0.1:4577</span><span>Git as source · Evidence as record</span>
   {/* ATS-111: the keyboard help. A shortcut that is not written down is
       not a shortcut a reader can use, so the bound commands are listed
       where the reader can see them. */}
   <details className="kbd-help" data-region="kbd-help"><summary>键盘操作</summary><ul>{keyboardHelpLines().map(l=><li key={l}>{l}</li>)}</ul></details>
  </footer>
  </div>
  {dialog&&<div className="overlay" onClick={()=>setDialog(false)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-project-title" onClick={e=>e.stopPropagation()}><h2 id="add-project-title">添加 Playwright 项目</h2><p>填写已有 Git 项目的本地绝对路径。系统不复制项目，也不会自动执行 npm install。</p>
   {/* ATS-111: the dialog is a REAL form, so the browser's own "submit
       the form" behaviour makes Enter work on the path field -- the key
       a reader presses after typing a path. The form's submit handler
       calls the same `addProject` the button calls, so the two paths
       cannot disagree. */}
   <form onSubmit={e=>{e.preventDefault();void addProject();}}>
   <input autoFocus aria-label="项目本地绝对路径" value={projectPath} onChange={e=>setProjectPath(e.target.value)} placeholder="C:\\Projects\\MyApp 或 /workspace/my-app"/>
   <div className="modal-actions"><button type="button" className="btn secondary" onClick={()=>setDialog(false)}>取消</button><button type="submit" className="btn primary" disabled={busy||!projectPath}>添加项目</button></div>
   </form></div></div>}
  {message&&<div className="toast">{message}</div>}
 </div>
}
