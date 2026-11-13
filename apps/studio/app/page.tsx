'use client';
import React,{useCallback,useEffect,useMemo,useState} from 'react';
import dynamic from 'next/dynamic';
import {Activity,BookOpen,Box,ChartNoAxesCombined,CheckCircle2,ChevronRight,Clock,Code2,Download,FileCode2,FilePlus2,FileSearch,FolderGit2,GitBranch,GitCommitHorizontal,Inbox,KeyRound,LayoutDashboard,Layers3,Loader2,Lock,Network,Play,RefreshCcw,Save,Search,ShieldAlert,Square,Terminal,TestTube2,Trash2,TriangleAlert,XCircle} from 'lucide-react';
import {api,cancellableApi,downloadArtifact,type Project,type TestDef,type TestCatalog,type Run,type Source,type CredentialRef,type CredentialStatus,type EgressScope,type EgressPreview,type EgressConsent,type SecurityContract,type EgressAuditRecord,type EvidenceMaterial,type Batch} from '../lib/api';
// ATS-111: the WORKBENCH STATE MODEL. The four states -- empty / failed /
// cancelled / loading -- are defined ONCE, here, and the unit tests assert
// on them (tests/workbench-state.test.mjs) without a browser. The view
// below only renders what the model says.
import {WORKBENCH_STATES,NO_PROJECT_STATE,deriveWorkbenchState,panelState,isTextEntry,hasNativeEnterAction,isComposing,escapeTarget,keyCommandFor,keyboardHelpLines,type WorkbenchStateKind} from '../lib/workbench-state.mjs';
// ATS-214: the CASE SEARCH / TAG / FILTER / SELECTION module. The SAME
// module the portable UI imports, so the two interfaces cannot disagree
// about what the catalogue shows -- and the SET semantics (a search and a
// filter COMPOSE as an intersection) live in ONE place.
import {filterCases,describeFilter,tagVocabulary,fileVocabulary,selectionSnapshot,selectionByFile,reconcileSelection,normalizeTag,TAG_MODE,type CaseFilter} from '../public/case-search.mjs';
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
// ATS-213: the caption under the "不可用密钥" metric.
//
// The caption states HOW MANY of each kind there are. It never says
// 「全部可用」 while a count above zero says otherwise -- a caption that
// contradicts the number it sits under is worse than no caption, because the
// reader has to work out which of the two to believe.
//
// The counts come from the MEASURED statuses. When the status read failed
// there are no measured statuses at all, and the caption says so instead of
// claiming that nothing is wrong.
function credUnavailableCaption(statuses:CredentialStatus[],failed:boolean):string{
 if(failed)return '可用状态读取失败，未测得';
 const notConfigured=statuses.filter(s=>s.status==='not-configured').length;
 const unavailable=statuses.filter(s=>s.status==='unavailable').length;
 const usable=statuses.filter(s=>s.status==='configured').length;
 if(!statuses.length)return '尚无引用';
 const parts:string[]=[];
 if(usable)parts.push(`可用 ${usable}`);
 if(notConfigured)parts.push(`未配置 ${notConfigured}`);
 if(unavailable)parts.push(`取不到 ${unavailable}`);
 return parts.join(' · ');
}
// ATS-213: the caption under the "凭据库" metric.
//
// The store's health is a MEASUREMENT (a real call into the store), not the
// backend's prediction about its own files. The panel never says 「已就绪」
// while a reference reads 「取不到」.
function credStoreCaption(health:{state:string;reason:string}|null,failed:boolean):string{
 if(failed)return '可用状态读取失败，未测得';
 if(!health)return '未测得';
 if(health.state==='ok')return '系统凭据库已就绪（实测）';
 if(health.state==='unavailable')return '本机系统凭据库不可用';
 return '系统凭据库调用失败';
}
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
 const Icon=kind==='loading'?Loader2:kind==='error'?TriangleAlert:Inbox;
 return <div className={'state-panel state-'+kind} role={s.role} aria-live={s.ariaLive} aria-busy={s.busy?'true':'false'} data-state={kind} data-state-token={s.token}>
  <div className="state-head"><Icon size={16} className={kind==='loading'?'spin':''} aria-hidden="true"/><b>{s.label}</b></div>
  <p className="state-detail">{detail||s.detail}</p>
  <p className="state-hint">{s.hint}</p>
  {onRetry&&<button className="btn secondary small state-retry" onClick={onRetry}><RefreshCcw size={13}/> {retryLabel||'重试'}</button>}
 </div>;
}
// ATS-111: the NO-PROJECT panel. It is a panel like the other four, but it
// is about the WORKSPACE rather than about a request: there is no project
// to load a catalogue for. It says so in its own words and points at the
// action that helps -- importing a project -- instead of talking about a
// filter that matched nothing.
function NoProjectPanel({onAddProject}:{onAddProject:()=>void}){
 return <div className="state-panel state-no-project" role="status" aria-live="polite" aria-busy="false" data-state="no-project" data-state-token={NO_PROJECT_STATE.token}>
  <div className="state-head"><FolderGit2 size={16} aria-hidden="true"/><b>{NO_PROJECT_STATE.label}</b></div>
  <p className="state-detail">{NO_PROJECT_STATE.detail}</p>
  <p className="state-hint">{NO_PROJECT_STATE.hint}</p>
  <button className="btn primary small state-retry" onClick={onAddProject}><FilePlus2 size={13}/> 添加项目</button>
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
 const [tab,setTab]=useState<Tab>('catalog'),[projectPath,setProjectPath]=useState('');
 // ATS-214: the FILTER and the SELECTION of the catalogue.
 //
 // The filter is the composition of the independent criteria (a text
 // query, the tags, the files); the composition itself -- and the SET
 // semantics of it -- is computed by the shared module, so this component
 // only chooses the INPUT. The selection is the set of uids the user
 // picked for the batch run.
 //
 // ATS-111's `filter` state (the plain text query of the search box) is
 // GONE: the query now lives in the shared filter, so the search box and
 // the tag criterion cannot drift apart. The search box writes into
 // `caseFilter.query`; the two are the same criterion.
 const [caseFilter,setCaseFilter]=useState<CaseFilter>({query:'',tags:[],tagMode:TAG_MODE.ANY,files:[],statuses:[]});
 const [selectedUids,setSelectedUids]=useState<string[]>([]);
 const [batches,setBatches]=useState<Batch[]>([]);
 const [dialog,setDialog]=useState(false),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [secContract,setSecContract]=useState<SecurityContract|null>(null),[credentials,setCredentials]=useState<CredentialRef[]>([]);
 // ATS-213: the AVAILABILITY STATUS of every stored credential. It is a
 // SEPARATE fetch from the reference list, because it is a different fact:
 // the list says "this machine remembers this reference", the status says
 // "the secret can be fetched right now". `credStatusError` keeps the
 // failure of that fetch -- a status that could not be measured must NOT be
 // rendered as "not configured", because that would claim a fact nobody
 // measured.
 //
 // `credStatusMeasuredAt` records WHEN the statuses were measured. When a
 // later read fails, the panel says "last measured at ..." and marks the
 // rows as STALE -- it does not present a status nobody measured as if it
 // were the current one, and the stale rows are not counted as usable.
 const [credStatuses,setCredStatuses]=useState<CredentialStatus[]>([]),[credStatusError,setCredStatusError]=useState(''),[credStatusMeasuredAt,setCredStatusMeasuredAt]=useState<string|null>(null);
 // ATS-213: the MEASURED health of the credential store. The store's own
 // prediction about its files is not what the panel shows: the panel shows
 // what a real call into the store returned.
 const [credStoreHealth,setCredStoreHealth]=useState<{state:string;reason:string}|null>(null);
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
 // ATS-111: the RELOAD counter.
 //
 // 「重新加载」 must really issue a new request. Setting the active
 // project to the value it already has is not a state change, so React
 // does not re-run the loading effect and no request is made -- the
 // button would be a no-op. A counter in the effect's dependency list
 // IS a change, so the effect re-runs and the request is issued again.
 const [reloadToken,setReloadToken]=useState(0);
 const reloadCatalogue=useCallback(()=>setReloadToken(n=>n+1),[]);
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
 // ATS-111: the run list is POLLED, and a poll that FAILS is reported.
 // A failed poll that is swallowed leaves the panel showing the last
 // known run list as if it were current -- a silent stale read, which
 // is the same class of defect as the catalogue's stale rows. The
 // failure is recorded so the runs panel can show it.
 useEffect(()=>{
  refresh();
  const t=setInterval(()=>{
   api<{runs:Run[]}>('/api/runs')
    .then(r=>{setRuns(r.runs);setRunsRequest({phase:'settled',itemCount:r.runs.length});})
    .catch(e=>setRunsRequest({phase:'failed',error:(e as Error).message}));
  },1800);
  return()=>clearInterval(t);
 },[refresh]);
 // ATS-111: the catalogue load is CANCELLABLE and reports its outcome.
 //
 // The request is aborted when the project changes, so the answer of the
 // project the reader left can never land on the project they are now
 // looking at -- and the reader is told the load was CANCELLED rather
 // than being left with a spinner that never resolves.
 //
 // The catalogue is CLEARED when the project changes. Holding the old
 // project's cases while the new one loads would present another
 // project's cases as the current project's -- the panel, the metrics
 // and the footer would all name cases the reader did not ask for.
 //
 // `reloadToken` is what makes 「重新加载」 work. Asking for the same
 // project again is not a state change, so React does not re-run the
 // effect and no request is made; the counter changes, so the effect
 // re-runs and the request is really issued again.
 useEffect(()=>{
  if(!active){
   setCatalog({tests:[],files:[],warning:'',uidVersion:0,projectUid:''});
   setCatalogueRequest({phase:'idle'});return;
  }
  let cancelled=false;
  setCatalog({tests:[],files:[],warning:'',uidVersion:0,projectUid:''});
  setCatalogueRequest({phase:'pending'});
  const controller=cancellableApi<TestCatalog>(`/api/projects/${active}/tests`);
  catalogueAbort.current=controller.abort;
  controller.promise.then(c=>{if(cancelled)return;setCatalog(c);setCatalogueRequest({phase:'settled',itemCount:c.tests.length});})
   .catch(e=>{if(cancelled||controller.cancelled())return;
    setCatalogueRequest({phase:'failed',error:(e as Error).message});notify((e as Error).message);});
  api<typeof lineage>(`/api/projects/${active}/lineage`).then(setLineage).catch(()=>setLineage({requirements:[],links:[]}));
  setSelected(null);setSource(null);
  return()=>{cancelled=true;controller.abort();catalogueAbort.current=null;};
 },[active,reloadToken]);
 // ATS-111: Escape cancels the load that is in flight. The cancellation
 // is a state of its own, so the reader can tell it apart from a failure
 // and from an empty list.
 const cancelCatalogue=useCallback(()=>{
  if(catalogueRequest.phase!=='pending')return false;
  catalogueAbort.current?.();catalogueAbort.current=null;
  setCatalogueRequest({phase:'cancelled'});return true;
 },[catalogueRequest.phase]);
 const selectedProject=projects.find(p=>p.id===active),projectRuns=runs.filter(r=>r.projectId===active),live=projectRuns.find(r=>['running','queued','cancelling'].includes(r.status));
 // ATS-214: the FILTERED catalogue. The composition of the criteria --
 // and the SET semantics of it -- is the shared module's job; this only
 // hands it the criteria. The result is a VIEW of the catalogue: the
 // order is the catalogue's, and the result never holds a case the
 // catalogue does not have.
 const shown=useMemo(()=>filterCases(catalog.tests,caseFilter),[catalog.tests,caseFilter]);
 const filterReport=useMemo(()=>describeFilter(catalog.tests,caseFilter),[catalog.tests,caseFilter]);
 // The vocabularies: the tags the catalogue actually carries (with their
 // counts) and the files it spans. A tag nobody carries is not offered --
 // ticking it would change nothing and look broken.
 const tagList=useMemo(()=>tagVocabulary(catalog.tests),[catalog.tests]);
 const fileList=useMemo(()=>fileVocabulary(catalog.tests),[catalog.tests]);
 // The SELECTION. It is a set of uids, and the snapshot is what the run
 // request carries -- self-contained, so the record can be read on its own.
 const selection=useMemo(()=>selectionSnapshot(catalog.tests,selectedUids),[catalog.tests,selectedUids]);
 const selectionGroups=useMemo(()=>selectionByFile(selection),[selection]);
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
 //
 // When the status read FAILS, the previously measured statuses are CLEARED
 // and the failure is recorded. A stale status shown next to the error note
 // reads as "this is the current state", and the metric cards would keep
 // counting it as usable -- a secret that may have been revoked would still
 // be reported as 可用. The panel reports "last measured at ..." instead.
 try{
  const s=await api<{statuses:CredentialStatus[];storeHealth?:{state:string;reason:string}}>('/api/security/credentials/status');
  setCredStatuses(s.statuses);setCredStatusError('');setCredStatusMeasuredAt(new Date().toISOString());
  setCredStoreHealth(s.storeHealth??null);
 }catch(e){
  setCredStatuses([]);setCredStatusError((e as Error).message);
 }
 },[]);
 useEffect(()=>{if(tab==='security')loadSecurity();},[tab,loadSecurity]);
 async function openFile(test:TestDef){setSelected(test);try{const s=await api<Source>(`/api/projects/${active}/source?file=${encodeURIComponent(test.file)}`);setSource(s);setDraft(s.content)}catch(e){notify((e as Error).message)}}
 async function addProject(){setBusy(true);try{const r=await api<{project:Project}>('/api/projects','POST',{path:projectPath});closeDialog();setProjectPath('');setActive(r.project.id);await refresh();notify('项目添加成功：未修改原仓库')}catch(e){notify((e as Error).message)}finally{setBusy(false)}}
 // ATS-111: closing the add-project dialog gives the focus BACK to the
 // button that opened it. Without this the focus falls onto the
 // <body>, and the document-level key commands still work -- but the
 // reader who just cancelled now has to walk the whole tab order back
 // to where they were.
 const closeDialog=useCallback(()=>{
  setDialog(false);
  // The focus is restored in a microtask, because the dialog is still
  // mounted when `setDialog(false)` is called and the browser would
  // refuse to move the focus onto an element that is about to be
  // replaced.
  queueMicrotask(()=>addProjectRef.current?.focus());
 },[]);
 // ATS-214: the BATCH run. The selection is sent as the uids of the
 // picked cases; the Bridge validates them against the catalogue, splits
 // them by file and chains one run per file. The selection itself is on
 // the run record, so "what was selected" and "what ran" can be compared
 // after the fact.
 async function runSelection(){if(!active||!selection.uids.length)return;setBusy(true);
  try{const {run}=await api<{run:Run}>(`/api/projects/${active}/run`,'POST',{selection:selection.uids});
   setRunDetail(run);setTab('runs');await refresh();
   const groups=selectionGroups.length;
   notify(groups>1?`已提交批量运行：${selection.count} 个用例，分 ${groups} 个文件依次执行`:`已提交运行：${selection.count} 个用例`);
  }catch(e){notify((e as Error).message)}finally{setBusy(false)}}
 // The selection helpers. The selection is a SET: ticking a case that is
 // already ticked removes it, and the order of the ticks is not part of
 // it.
 function toggleSelect(uid:string){setSelectedUids(u=>u.includes(uid)?u.filter(x=>x!==uid):[...u,uid]);}
 function selectAllShown(){setSelectedUids(u=>[...new Set([...u,...shown.map(t=>t.uid)])]);}
 function clearSelection(){setSelectedUids([]);}
 // The tag filter: a tag is ticked or not, and the MODE decides what
 // several ticked tags mean -- "任一" (any of them) or "全部" (all of
 // them). The mode is shown, so the reader knows which one the list used.
 function toggleTag(tag:string){setCaseFilter(f=>{const t=normalizeTag(tag);return {...f,tags:f.tags.includes(t)?f.tags.filter(x=>x!==t):[...f.tags,t]};});}
 function toggleFile(file:string){setCaseFilter(f=>({...f,files:f.files.includes(file)?f.files.filter(x=>x!==file):[...f.files,file]}));}
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
 //   Enter         submits what is on screen (the script editor's
 //                  unsaved draft);
 //   Ctrl+Enter    runs the case that is selected;
 //   Ctrl+P        moves the focus to the script search.
 //
 // The forms on the screen (the add-project dialog, the credential
 // form) are REAL forms, so their own Enter behaviour is the browser's
 // and the workbench does not have to reproduce it.
 const searchRef=React.useRef<HTMLInputElement|null>(null);
 // ATS-111: the element that opened the add-project dialog. When the
 // dialog closes, the focus goes BACK to it: without that, the focus
 // falls onto the <body>, and a keyboard reader who then presses Ctrl+P
 // finds that nothing happens -- and that Esc does not cancel the load
 // either.
 const addProjectRef=React.useRef<HTMLButtonElement|null>(null);
 const runCurrent=useCallback(async()=>{
  if(!active)return;if(live)return;
  await execute(selected?.file??null);
 },[active,live,selected?.file]);
 // ATS-111: the key handler.
 //
 // It is attached to the DOCUMENT, not to the app shell. A handler on a
 // container only receives the keys that happen to be inside it, so a
 // reader whose focus sits on the <body> -- which is where the focus
 // lands after the page loads and after a dialog closes -- would find
 // that Escape does not cancel the load and Ctrl+P does not move the
 // focus, even though the loading panel says 「按 Esc 可以取消这次加载」.
 //
 // Three things are left to the browser on purpose:
 //
 //   1. an IME composition -- Escape belongs to the input method;
 //   2. Enter inside a text field -- the browser submits the form;
 //   3. Enter on a control with a NATIVE action -- a button, a link, a
 //      summary. The browser fires the control's own click, and the
 //      workbench must NOT perform a different write instead: focusing
 //      「取消」 and pressing Enter has to CANCEL, not add the project.
 const onWorkbenchKey=useCallback((e:KeyboardEvent)=>{
  if(isComposing(e))return;
  const command=keyCommandFor(e);
  if(!command)return;
  const target=e.target as HTMLElement|null;
  if(command==='cancel'){
   // The three things Escape can cancel are NESTED, and the innermost
   // one wins: the dialog, then the load, then the run. The decision is
   // the MODEL's (`escapeTarget`), so the order is asserted by the unit
   // tests and the view only carries it out.
   //
   // The RUN is the third one, and it is the one the footer PROMISES:
   // the help line says 「关闭弹窗，或取消正在进行的加载或运行」, so
   // pressing Escape during a running test has to stop that test -- the
   // same endpoint the 「停止运行」 button uses. The round-2 review
   // rejected the delivery because the help claimed this and the key
   // did nothing.
   const target_=escapeTarget({dialogOpen:dialog,loadPending:catalogueRequest.phase==='pending',runActive:Boolean(live)});
   if(target_==='dialog'){closeDialog();e.preventDefault();return;}
   if(target_==='load'){if(cancelCatalogue()){e.preventDefault();return;}return;}
   if(target_==='run'){
    // The stop is REQUESTED, and the run's final status is decided by
    // the engine when the process closes -- the same contract as the
    // 「停止运行」 button.
    if(live)void api(`/api/runs/${live.id}/stop`,'POST').then(()=>refresh()).catch(err=>notify((err as Error).message));
    e.preventDefault();return;
   }
   return;
  }
  if(command==='focus-search'){
   // The dialog is modal: the focus stays inside it, and the key must
   // NOT leak to the browser. The round-2 review found that the
   // handler returned EARLY without preventDefault(), so Ctrl+P fell
   // through to the browser's own Print command. The key is consumed
   // here -- the focus simply does not move.
   if(dialog){e.preventDefault();return;}
   searchRef.current?.focus();e.preventDefault();return;
  }
  if(command==='run-current'){
   // The dialog is modal: a key pressed in it must not start a run in
   // the background behind it.
   if(dialog)return;
   // A text field keeps its own keys: pressing Ctrl+Enter while
   // typing a path must not start a run.
   if(isTextEntry(target))return;
   void runCurrent();e.preventDefault();return;
  }
  if(command==='submit'){
   // A text field keeps its own Enter behaviour.
   if(isTextEntry(target))return;
   // A control with its own Enter action keeps it: the browser fires
   // that control's click, and the workbench does not perform a
   // different write on top of it. Focusing 「取消」 and pressing Enter
   // has to CANCEL -- not add the project.
   if(hasNativeEnterAction(target))return;
   if(selected&&source&&draft!==source.content){void save();e.preventDefault();return;}
  }
 },[dialog,projectPath,tab,keyName,keySecret,selected,source,draft,catalogueRequest.phase,live,closeDialog,refresh,cancelCatalogue,runCurrent]);
 // ATS-111: the key commands are bound to the DOCUMENT.
 //
 // A handler on the app shell only receives the keys that land inside
 // it, and the focus is not always inside it: after the page loads, and
 // after a dialog closes, the focus sits on the <body>. The loading
 // panel tells the reader 「按 Esc 可以取消这次加载」, so Escape has to
 // work there -- and Ctrl+P has to move the focus to the search box
 // from there too.
 useEffect(()=>{
  document.addEventListener('keydown',onWorkbenchKey);
  return()=>document.removeEventListener('keydown',onWorkbenchKey);
 },[onWorkbenchKey]);
 // ATS-111: the FOCUS TRAP of the add-project dialog.
 //
 // The dialog declares `aria-modal="true"`, which promises the reader
 // that the rest of the page is not reachable while it is open. Tab
 // walking into the background breaks that promise: a screen-reader
 // user would find themselves in the rail behind the dialog.
 //
 // The trap keeps the focus inside the dialog and wraps around at both
 // ends. It is a CAPTURE-phase listener, so it runs before the browser
 // moves the focus -- which is what makes the wrap-around work.
 useEffect(()=>{
  if(!dialog)return;
  const onKeyDown=(e:KeyboardEvent)=>{
   if(e.key!=='Tab')return;
   const modal=document.querySelector('.modal[role="dialog"]');
   if(!modal)return;
   const focusable=[...modal.querySelectorAll<HTMLElement>('input,button,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')]
    .filter(el=>!el.hasAttribute('disabled')&&el.offsetParent!==null);
   if(!focusable.length)return;
   const first=focusable[0],last=focusable[focusable.length-1];
   const active=document.activeElement as HTMLElement|null;
   if(e.shiftKey){
    if(active===first||!modal.contains(active)){last.focus();e.preventDefault();}
   }else if(active===last||!modal.contains(active)){
    first.focus();e.preventDefault();
   }
  };
  document.addEventListener('keydown',onKeyDown,true);
  return()=>document.removeEventListener('keydown',onKeyDown,true);
 },[dialog]);
 // ATS-111: the state of the catalogue panel, decided by the MODEL.
 // The panel component renders the ARIA attributes itself, from the same
 // model, so there is no second copy of them here to drift.
 //
 // The panel state has TWO axes: what the request did (the four states)
 // and whether there is a project at all. Without a project the request
 // is idle, so the four-state mapping alone would fall through to "the
 // filter matched nothing" -- a message about a list that does not
 // exist. The model composes the two axes.
 const catalogueState=deriveWorkbenchState(catalogueRequest);
 const panel=panelState(catalogueRequest,{hasProject:Boolean(active)});
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
 // ATS-111: the workbench root. The skip link is the first focusable
 // element: it lets a keyboard user jump straight to the content
 // instead of walking the rail.
 //
 // The KEY HANDLER is NOT on this element -- it is on the document (see
 // the effect above), so that it also works when the focus is on the
 // <body>.
 return <div className="app-shell">
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
    <button className="btn secondary" ref={addProjectRef} onClick={()=>setDialog(true)} data-region="add-project"><FilePlus2 size={15}/> 添加项目</button>
   </section>
   <section className="workspace">
    <aside className="sidebar" aria-label="资源列表" data-region="sidebar"><div className="sidebar-head"><div className="eyebrow">EXPLORER</div><h3>{tab==='catalog'?'测试资产':tab==='runs'?'运行记录':tab==='quality'?'质量概览':tab==='evidence'?'证据工作台':tab==='trace'?'需求列表':'模块概览'}</h3></div>
     {tab==='catalog'&&<><div className="search" role="search" data-region="search"><Search size={15}/><input ref={searchRef} placeholder="查找用例名 / 文件 / 标签" aria-label="查找用例名、文件或标签" value={caseFilter.query} onChange={e=>setCaseFilter(f=>({...f,query:e.target.value}))}/></div>
     {/* ATS-214: the FILTERS. The tag criterion and the file criterion
         are stated separately, and the mode of the tag criterion is
         LABELLED -- the reader has to know whether several ticked tags
         mean "any of them" or "all of them". */}
     <div className="filter-box">
      <div className="filter-head"><span className="eyebrow">TAGS</span>
       {tagList.length>0&&<select value={caseFilter.tagMode} onChange={e=>setCaseFilter(f=>({...f,tagMode:e.target.value as 'any'|'all'}))} className="mode-select" aria-label="多个标签的口径" title="多个标签的口径"><option value="any">任一</option><option value="all">全部</option></select>}
      </div>
      <div className="tag-list">{tagList.map(t=><button key={t.tag} className={'tag-chip'+(caseFilter.tags.includes(t.tag)?' on':'')} onClick={()=>toggleTag(t.tag)} aria-pressed={caseFilter.tags.includes(t.tag)} title={`${t.count} 个用例`}><span>@{t.tag}</span><small>{t.count}</small></button>)}</div>
      {!tagList.length&&<p className="muted" style={{fontSize:10,margin:'4px 0 0'}}>该项目没有标签。Playwright 用 <code>{'{ tag: "@smoke" }'}</code> 声明标签。</p>}
      {fileList.length>1&&<><div className="filter-head" style={{marginTop:10}}><span className="eyebrow">FILES</span></div>
      <div className="tag-list">{fileList.map(f=><button key={f.file} className={'tag-chip'+(caseFilter.files.includes(f.file)?' on':'')} onClick={()=>toggleFile(f.file)} aria-pressed={caseFilter.files.includes(f.file)} title={f.file}><span>{f.file}</span><small>{f.count}</small></button>)}</div></>}
      {/* The criteria are reported SEPARATELY: a reader can see which
          criterion narrowed the list and by how much. The list alone
          cannot tell "nothing matched" from "the intersection was
          empty". */}
      <div className="filter-report">{filterReport.matched} / {filterReport.total} 条{filterReport.criteria.filter(c=>c.active).map(c=>`${c.kind === 'search' ? '搜索' : c.kind === 'tag' ? '标签' : c.kind === 'file' ? '文件' : '状态'} ${c.kept}`).join(' · ')}</div>
     </div>
     {/* ATS-214: the SELECTION. The count, the "select all shown" and the
         "run the selection" are here, next to the list they act on. */}
     <div className="select-bar">
      <span>已选 {selection.count} 条</span>
      <button className="link-btn" onClick={selectAllShown} disabled={!shown.length}>全选当前</button>
      <button className="link-btn" onClick={clearSelection} disabled={!selection.count}>清空</button>
     </div>
     {/* ATS-111: the four states of the catalogue panel. Only ONE of them
         is shown at a time, and each says something different: the list
         is empty, the load failed, the load was cancelled, or the load is
         still running. */}
     <div className="file-list" data-region="panel" data-catalogue-state={panel?panel.kind:'ready'}>
     {panel&&panel.kind==='loading'&&<StatePanel kind="loading"/>}
     {panel&&panel.kind==='error'&&<StatePanel kind="error" detail={catalogueRequest.error?`原因：${catalogueRequest.error}`:undefined} onRetry={reloadCatalogue} retryLabel="重新加载"/>}
     {panel&&panel.kind==='cancelled'&&<StatePanel kind="cancelled" onRetry={reloadCatalogue} retryLabel="重新加载"/>}
     {panel&&panel.kind==='empty'&&<StatePanel kind="empty" detail="这个项目里没有可执行的测试用例。" onRetry={reloadCatalogue} retryLabel="重新加载"/>}
     {panel&&panel.kind==='no-project'&&<NoProjectPanel onAddProject={()=>setDialog(true)}/>}
     {shown.map(t=><button key={t.id} className={'file-item '+(selected?.id===t.id?'selected':'')} onClick={()=>openFile(t)}><span className={'pick-box'+(selectedUids.includes(t.uid)?' on':'')} onClick={e=>{e.stopPropagation();toggleSelect(t.uid);}} role="checkbox" aria-checked={selectedUids.includes(t.uid)} aria-label={`选中 ${t.title}`} title="选中以批量运行"/><FileCode2 size={16}/><span><b>{t.title}</b><small>{t.file}:{t.line}</small>{(t.tags&&t.tags.length)?<small className="tag-line">{t.tags.map(x=>'@'+x).join(' ')}</small>:null}<small className="uid-tag">{t.uid}{t.uidStable?'':' ⚠'}</small></span><ChevronRight size={14}/></button>)}
     {/* The filter matched nothing -- a DIFFERENT fact from "the project has
         no cases at all", so it is a different message. And it is only
         shown when there IS a project and a catalogue to filter: without
         a project the panel says so instead.

         The two lines are SEPARATE elements, not one string with a
         `<br/>` in it: inside a JSX text literal a `<br/>` is not a tag,
         so the reader saw the characters `<br/>` on the screen. The
         round-2 review spotted it (R2-6) as a leftover from ATS-214; it
         is not a blocker for ATS-111, but it is in the panel this task
         owns, so it is fixed here. */}
     {!panel&&!shown.length&&<div className="empty-small">{catalog.tests.length?<><span>没有符合当前条件的用例</span><br/><span>搜索与过滤条件按「交集」叠加</span></>:<span>这个项目里没有可执行的测试用例。</span>}</div>}
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
     {tab==='catalog'&&<><div className="section-top"><div><div className="eyebrow">TEST CATALOG / SOURCE OF TRUTH</div><h1>{selected?.title||'测试目录与脚本工作台'}</h1><p>{selected?.file||'在左侧选择一个测试用例，查看可视化步骤与 TypeScript 原始脚本。'}</p></div><div className="button-group">
      {/* ATS-214: the BATCH run button. It is enabled when cases are
          picked, and it says how many -- the user can see what is about
          to run before it runs. */}
      <button className="btn primary" onClick={runSelection} disabled={!active||!!live||busy||!selection.count} title={selectionGroups.length?`将分 ${selectionGroups.length} 个文件依次执行`:'运行选中的用例'}><Play size={15}/> 批量运行{selection.count?`（${selection.count}）`:''}</button>
      <button className="btn secondary" onClick={()=>execute(null)} disabled={!active||!!live}><Play size={15}/> 运行全部</button><button className="btn secondary" onClick={()=>execute(selected?.file||null)} disabled={!active||!!live}><Play size={15}/> {selected?'运行脚本':'执行测试'}</button></div></div>
     <div className="metric-row"><div className="metric"><span>可管理用例</span><strong>{catalog.tests.length}</strong><small>静态索引 · Git 原生</small></div><div className="metric"><span>当前筛选</span><strong>{filterReport.matched}</strong><small>搜索与过滤取交集</small></div><div className="metric"><span>已选中</span><strong>{selection.count}</strong><small>可批量运行</small></div><div className="metric"><span>累计运行</span><strong>{stats.total}</strong><small>append-only execution</small></div></div>
     {/* ATS-214: the SELECTION RECORD. What was selected, in full, before
         the run: the cases with their file, title and line, and how the
         batch is split into runs. This is the same snapshot the run
         record carries, so the two can be compared. */}
     {selection.count>0&&<div className="card"><div className="card-title"><Layers3 size={16}/> 已选用例（{selection.count}）· 分 {selectionGroups.length} 个文件执行</div>
      <table><thead><tr><th>用例</th><th>文件</th><th>行</th><th>UID</th></tr></thead><tbody>{selection.cases.map(c=><tr key={c.uid}><td><b>{c.title}</b></td><td><code className="mono">{c.file}</code></td><td>{c.line??'—'}</td><td><code className="mono">{c.uid}</code></td></tr>)}</tbody></table>
      <div className="panel-foot">选择集合是快照：它记下了选中时每条用例的文件、标题与行号，因此即使目录随后变化，这条记录仍可独立阅读。引擎每次只接受一个测试文件过滤参数，所以跨文件的批量运行会按文件依次执行。</div></div>}
     {selected&&source?<div className="editor-panel"><div className="panel-head"><div className="panel-tabs"><button className={view==='graph'?'active':''} onClick={()=>setView('graph')}><Network size={15}/> 流程视图</button><button className={view==='code'?'active':''} onClick={()=>setView('code')}><Code2 size={15}/> 代码视图</button></div><div className="panel-right"><span className="quiet">{draft!==source.content?'● 未保存':'已同步 Git 工作区'}</span><button className="btn small" onClick={()=>setView('code')}><Code2 size={13}/> 编辑</button><button className="btn primary small" onClick={save} disabled={draft===source.content}><Save size={13}/> 保存</button></div></div>
     {view==='graph'?<div className="graph-view"><div className="graph-label">READ ONLY · 语义投影，不覆盖复杂 TS</div>{steps.map((s,i)=><React.Fragment key={i}><div className="flow-node"><span className="step-n">{String(i+1).padStart(2,'0')}</span><div><small>{s.kind} · L{s.line}</small><code>{s.name}</code></div></div>{i<steps.length-1&&<div className="flow-line"/>}</React.Fragment>)}{!steps.length&&<div className="empty-small">此脚本包含复杂或不支持的表达式，请使用代码视图编辑。</div>}</div>:<div className="code-editor"><Monaco height="420px" language="typescript" theme="vs-dark" value={draft} onChange={v=>setDraft(v||'')} options={{minimap:{enabled:false},fontSize:13,wordWrap:'on',automaticLayout:true}}/></div>}
     <div className="panel-foot">当前阶段的流程图为只读投影；复杂 TypeScript 始终由源代码保持完整表达。编辑保存采用 SHA-256 乐观并发检查。</div></div>:<div className="welcome"><div className="welcome-icon"><FolderGit2 size={35}/></div><h2>从 Git 到可视化测试</h2><p>保留已有 Playwright 工程结构。选择项目与脚本后，可以查看步骤、编辑源码、运行用例并收集证据。</p><button className="btn primary" onClick={()=>setDialog(true)}>导入本地 Git 项目</button></div>}
     {catalog.warning&&<div className="note"><ShieldAlert size={15}/>{catalog.warning}</div>}</>}
     {tab==='runs'&&<><div className="section-top"><div><div className="eyebrow">EXECUTION CENTER</div><h1>执行中心</h1><p>保留每次运行的完整状态、错误日志与 Playwright 原始证据。</p></div>{live&&<button className="btn danger" onClick={async()=>{await api(`/api/runs/${live.id}/stop`,'POST');refresh()}}><Square size={14}/> 停止运行</button>}</div>
      {currentRun?<><div className="metric-row"><div className="metric"><span>当前运行</span><strong className="small-value">{label[currentRun.status]||currentRun.status}</strong><small>{currentRun.gitCommit}</small></div><div className="metric"><span>通过</span><strong>{currentRun.summary?.passed??'—'}</strong></div><div className="metric"><span>失败</span><strong>{currentRun.summary?.failed??'—'}</strong></div><div className="metric"><span>总用例</span><strong>{currentRun.summary?.total??'—'}</strong></div></div>
      <div className="split"><div className="card grow"><div className="card-title"><Terminal size={16}/> 实时输出与历史日志</div><pre className="console">{currentRun.log||currentRun.error||'正在等待执行输出…'}</pre></div><div className="card evidence"><div className="card-title"><Download size={16}/> 运行证据</div>{currentRun.artifacts?.length?currentRun.artifacts.map(a=><button key={a.file} className="artifact" onClick={()=>downloadArtifact(currentRun.id,a.file).catch(e=>notify(e.message))}><span>{a.file}</span><small>{Math.ceil(a.size/1024)} KB</small></button>):<p className="muted">测试完成后显示 JSON / HTML / trace.zip / 截图等原始附件。</p>}</div></div>
      {/* ATS-214: the RECONCILIATION of the selection against what ran.
          「选了什么、跑了什么，两边对得上」 -- the two facts are compared
          here, and the difference is shown rather than smoothed away. */}
      {currentRun.selection&&<div className="card"><div className="card-title"><Layers3 size={16}/> 选择集合与实际执行的对账</div>
       {(()=>{const executed=(currentRun.attempts??[]).map(a=>a.testUid).filter((u):u is string=>Boolean(u));
        const r=reconcileSelection({uids:currentRun.selection.uids},executed);
        return <><table><thead><tr><th>核对项</th><th>数量</th><th>结论</th></tr></thead><tbody>
        <tr><td>选中用例</td><td>{r.selected}</td><td>运行记录里的选择集合</td></tr>
        <tr><td>实际执行的用例</td><td>{r.executed}</td><td>本次运行 attempt 绑定的 UID</td></tr>
        <tr><td>选中但未执行</td><td>{r.missing.length}</td><td className={r.missing.length?'bad':'ok'}>{r.missing.length?'缺失：'+r.missing.join('、'):'无缺失'}</td></tr>
        <tr><td>执行但未选中</td><td>{r.extra.length}</td><td className={r.extra.length?'warn':'ok'}>{r.extra.length?'多跑：'+r.extra.join('、'):'无多跑'}</td></tr>
        <tr><td>选择可复现</td><td>—</td><td className={r.matches?'ok':'bad'}>{r.matches?'选中的用例全部执行':'选中的用例未全部执行'}</td></tr>
        </tbody></table>
        <div className="panel-foot">选择集合是运行开始时的快照，它与本次运行的 attempt 是两条独立的事实；上表是两者的比对。多跑不破坏「选择集合可复现」——选择集合仍然就是用户选中的那几条——但它必须被看见。</div></>})()}
      </div>}
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
      <div className="metric-row"><div className="metric"><span>凭据库</span><strong className="small-value" data-region="cred-store-state">{credStoreHealth?.state==='ok'?(secContract?.provider||'可用'):(secContract?.provider||'不可用')}</strong><small data-region="cred-store-caption">{credStoreCaption(credStoreHealth,!!credStatusError)}</small></div><div className="metric"><span>可用密钥</span><strong data-region="cred-configured-count">{credStatusError?0:credStatuses.filter(s=>s.status==='configured').length}</strong><small>共 {credentials.length} 条引用 · 本地只保留引用</small></div><div className="metric"><span>不可用密钥</span><strong data-region="cred-unavailable-count">{credStatusError?0:credStatuses.filter(s=>s.status!=='configured').length}</strong><small data-region="cred-unavailable-caption">{credUnavailableCaption(credStatuses,!!credStatusError)}</small></div><div className="metric"><span>有效授权</span><strong>{consents.filter(c=>c.state==='granted').length}</strong><small>到期自动失效</small></div></div>
      <div className="split"><div className="card grow"><div className="card-title"><KeyRound size={16}/> 密钥存储</div>
       <p className="muted">密钥本体写入<b>系统凭据库</b>；本机索引只保留引用与指纹。没有任何接口会返回密钥原文。</p>
       {/* ATS-111: the credential form is a REAL form, so Enter in the
           name field submits it the way the browser does it. The workbench
          's own submit command does NOT reach it -- otherwise pressing
           Enter on an unrelated button (a rail tab, say) would save a
           draft the reader never asked to save. */}
       <form className="cred-form" onSubmit={e=>{e.preventDefault();void saveKey();}}>
        <div className="panel-right" style={{justifyContent:'flex-start',gap:8,margin:'10px 0'}}><input placeholder="密钥名称" value={keyName} onChange={e=>setKeyName(e.target.value)}/><input placeholder="密钥内容" type="password" value={keySecret} onChange={e=>setKeySecret(e.target.value)}/><button type="submit" className="btn primary small" disabled={busy||!keyName||!keySecret}><Save size={13}/> 存入</button></div>
       </form>
       {/* ATS-213: the STATUS column. Each stored credential carries exactly
           one status, measured against the OS credential store. The status is
           a WORD, not only a colour (docs/05-UI-UX.md §4), and the reason
           code is spelled out: "未配置" (re-enter the secret) and "取不到"
           (the store is unreachable) call for different actions. When the
           status could not be READ, the panel says so instead of guessing a
           status -- an unmeasured status rendered as "未配置" would be a
           fabricated fact.
       */}
       {/* The REFERENCE LIST is rendered from `credentials` -- the list the
           bridge reported -- and NOT from the measured statuses. The two
           are different facts, and a status read that fails must not take
           the references with it: the references are still there, and the
           reader still has to be able to delete one. Rendering the list from
           the statuses would make a failed status read look like "every
           credential is gone", and would take the delete buttons away. */}
       {credStatusError&&<div className="note" role="status" data-region="cred-status-error"><TriangleAlert size={15}/>可用状态读取失败：{credStatusError}（下方只列出引用，不代表密钥可用）{credStatusMeasuredAt&&`（上次测得于 ${formatTime(credStatusMeasuredAt)}，现已失效，不计入可用密钥）`}</div>}
       {credStatuses.map(s=>{const tone=s.status==='configured'?'ok':'bad';
        return <div className="result-item" key={s.id} data-region="cred-status" data-cred-status={s.status}>
         <span className={tone}>{s.status==='configured'?<CheckCircle2 size={15}/>:<TriangleAlert size={15}/>}</span>
         <div><b>{s.name}</b><small>{s.provider} · 指纹 {s.fingerprint} · {s.purpose}</small>
          <small data-region="cred-status-label"><b className={tone}>{credStatusLabel[s.status]??s.status}</b> · {credStatusReason[s.reason]??s.reason} · 查于 {formatTime(s.checkedAt)}</small></div>
         <button className="btn danger small" onClick={()=>removeKey(s.id)}><Trash2 size={13}/> 删除</button></div>})}
       {/* The references WITHOUT a measured status. These are the ones the
           status read did not cover: either the read failed, or the
           reference has no status at all. They are listed, they can be
           deleted, and they are NOT counted as usable.

           They are rows of the SAME panel, so they carry the same region --
           the note above says 「下方只列出引用」, and that has to be true:
           the rows below ARE the references, whether or not a status was
           measured for them. `data-cred-status="unknown"` says what the row
           is: its status was NOT measured. A row that claimed a measured
           status would be a fabricated fact.
       */}
       {credentials.filter(c=>!credStatuses.some(s=>s.id===c.id)).map(c=>
        <div className="result-item" key={c.id} data-region="cred-status" data-cred-status="unknown" data-cred-reference="true">
         <span className="bad"><TriangleAlert size={15}/></span>
         <div><b>{c.name}</b><small>{c.provider} · 指纹 {c.fingerprint} · {c.purpose}</small>
          <small data-region="cred-status-label"><b className="bad">状态未测得</b> · 引用在册，可用状态未知</small></div>
         <button className="btn danger small" onClick={()=>removeKey(c.id)}><Trash2 size={13}/> 删除</button></div>)}
       {!credentials.length&&!credStatusError&&<p className="muted">尚未存入任何密钥。</p>}
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
  {dialog&&<div className="overlay" onClick={()=>closeDialog()}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-project-title" onClick={e=>e.stopPropagation()}><h2 id="add-project-title">添加 Playwright 项目</h2><p>填写已有 Git 项目的本地绝对路径。系统不复制项目，也不会自动执行 npm install。</p>
   {/* ATS-111: the dialog is a REAL form, so the browser's own "submit
       the form" behaviour makes Enter work on the path field -- the key
       a reader presses after typing a path. The form's submit handler
       calls the same `addProject` the button calls, so the two paths
       cannot disagree.
       The focus is TRAPPED inside the dialog: the dialog says
       `aria-modal="true"`, and a modal dialog that lets Tab walk into
       the page behind it is a lie -- a screen-reader user who tabs past
       the last control would find themselves in the background. */}
   <form onSubmit={e=>{e.preventDefault();void addProject();}}>
   <input autoFocus aria-label="项目本地绝对路径" value={projectPath} onChange={e=>setProjectPath(e.target.value)} placeholder="C:\\Projects\\MyApp 或 /workspace/my-app"/>
   <div className="modal-actions"><button type="button" className="btn secondary" onClick={()=>closeDialog()}>取消</button><button type="submit" className="btn primary" disabled={busy||!projectPath}>添加项目</button></div>
   </form></div></div>}
  {message&&<div className="toast">{message}</div>}
 </div>
}
