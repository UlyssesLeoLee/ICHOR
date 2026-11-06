'use client';
import React,{useCallback,useEffect,useMemo,useState} from 'react';
import dynamic from 'next/dynamic';
import {Activity,BookOpen,Box,ChartNoAxesCombined,CheckCircle2,ChevronRight,Clock,Code2,Download,FileCode2,FilePlus2,FolderGit2,GitBranch,GitCommitHorizontal,LayoutDashboard,Layers3,Network,Play,RefreshCcw,Save,Search,ShieldAlert,Square,Terminal,TestTube2,XCircle} from 'lucide-react';
import {api,downloadArtifact,type Project,type TestDef,type TestCatalog,type Run,type Source} from '../lib/api';
const Monaco=dynamic(()=>import('@monaco-editor/react'),{ssr:false});
type Tab='catalog'|'runs'|'trace'|'architecture';
const label:Record<string,string>={passed:'通过',failed:'失败',running:'运行中',queued:'排队中',cancelling:'停止中',cancelled:'已停止',interrupted:'中断',error:'错误'};
function formatTime(s?:string|null){return s?new Date(s).toLocaleString('zh-CN',{hour12:false}):'—'}
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
 const [lineage,setLineage]=useState<{requirements:{uid:string,title:string,status?:string}[],links:{from:string,to:string,type?:string}[]}>({requirements:[],links:[]});
 const notify=(s:string)=>{setMessage(s);setTimeout(()=>setMessage(''),5500)};
 const refresh=useCallback(async()=>{try{
  const [p,r]=await Promise.all([api<{projects:Project[]}>('/api/projects'),api<{runs:Run[]}>('/api/runs')]);setProjects(p.projects);setRuns(r.runs);
  if(!active&&p.projects.length)setActive(p.projects[0].id);
 }catch(e){notify((e as Error).message)}},[active]);
 useEffect(()=>{refresh();const t=setInterval(()=>{api<{runs:Run[]}>('/api/runs').then(r=>setRuns(r.runs)).catch(()=>{})},1800);return()=>clearInterval(t)},[refresh]);
 useEffect(()=>{if(!active){setCatalog({tests:[],files:[],warning:'',uidVersion:0,projectUid:''});return;}
  api<TestCatalog>(`/api/projects/${active}/tests`).then(setCatalog).catch(e=>notify(e.message));
  api<typeof lineage>(`/api/projects/${active}/lineage`).then(setLineage).catch(()=>setLineage({requirements:[],links:[]}));
  setSelected(null);setSource(null);
 },[active]);
 const selectedProject=projects.find(p=>p.id===active),projectRuns=runs.filter(r=>r.projectId===active),live=projectRuns.find(r=>['running','queued','cancelling'].includes(r.status));
 const shown=catalog.tests.filter(t=>`${t.file} ${t.title}`.toLowerCase().includes(filter.toLowerCase()));
 const stats={passed:projectRuns.filter(r=>r.status==='passed').length,failed:projectRuns.filter(r=>r.status==='failed').length,total:projectRuns.length};
 const currentRun=runDetail && runDetail.projectId===active ? runDetail : projectRuns[0];
 useEffect(()=>{if(currentRun?.id&&tab==='runs')api<{run:Run}>(`/api/runs/${currentRun.id}`).then(r=>setRunDetail(r.run)).catch(()=>{});},[runs,tab,currentRun?.id]);
 async function openFile(test:TestDef){setSelected(test);try{const s=await api<Source>(`/api/projects/${active}/source?file=${encodeURIComponent(test.file)}`);setSource(s);setDraft(s.content)}catch(e){notify((e as Error).message)}}
 async function addProject(){setBusy(true);try{const r=await api<{project:Project}>('/api/projects','POST',{path:projectPath});setDialog(false);setProjectPath('');setActive(r.project.id);await refresh();notify('项目添加成功：未修改原仓库')}catch(e){notify((e as Error).message)}finally{setBusy(false)}}
 async function execute(file:string|null){if(!active)return;try{const {run}=await api<{run:Run}>(`/api/projects/${active}/run`,'POST',{file});setRunDetail(run);setTab('runs');await refresh();notify('已提交到本地 Playwright Runner')}catch(e){notify((e as Error).message)}}
 async function save(){if(!selected||!source)return;try{const r=await api<{hash:string}>(`/api/projects/${active}/source`,'PUT',{file:selected.file,content:draft,baseHash:source.hash});setSource({...source,content:draft,hash:r.hash});notify('已保存至原仓库工作区，未自动 Git commit')}catch(e){notify((e as Error).message)}}
 const steps=useMemo(()=>stepsOf(draft),[draft]);
 return <div className="app-shell">
  <aside className="rail"><div className="mark"><TestTube2 size={23}/></div>
   <button title="测试目录" className={tab==='catalog'?'rail-btn active':'rail-btn'} onClick={()=>setTab('catalog')}><Layers3 size={20}/></button>
   <button title="执行中心" className={tab==='runs'?'rail-btn active':'rail-btn'} onClick={()=>setTab('runs')}><Activity size={20}/></button>
   <button title="需求追踪" className={tab==='trace'?'rail-btn active':'rail-btn'} onClick={()=>setTab('trace')}><Network size={20}/></button>
   <button title="架构和限制" className={tab==='architecture'?'rail-btn active':'rail-btn'} onClick={()=>setTab('architecture')}><Box size={20}/></button>
   <div className="rail-bottom"><span className="live-dot"/></div>
  </aside>
  <div className="main-column">
   <header className="topbar"><div className="brand">AI Test <span>Studio</span><small>LOCAL · 0.1.0</small></div>
    <div className="top-actions"><span className="chip subdued"><ShieldAlert size={13}/> 本地可信仓库模式</span><button className="icon-btn" onClick={()=>refresh()} title="刷新"><RefreshCcw size={16}/></button></div></header>
   <section className="projectbar"><div><span className="eyebrow">WORKSPACE</span><select value={active} onChange={e=>setActive(e.target.value)} className="project-select"><option value="">选择测试项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
    {selectedProject&&<div className="repo-meta"><span><GitBranch size={14}/>{selectedProject.git.branch}</span><span><GitCommitHorizontal size={14}/>{selectedProject.git.commit}</span>{selectedProject.git.dirty&&<span className="dirty">未提交修改</span>}</div>}
    <button className="btn secondary" onClick={()=>setDialog(true)}><FilePlus2 size={15}/> 添加项目</button>
   </section>
   <section className="workspace">
    <aside className="sidebar"><div className="sidebar-head"><div className="eyebrow">EXPLORER</div><h3>{tab==='catalog'?'测试资产':tab==='runs'?'运行记录':tab==='trace'?'需求列表':'模块概览'}</h3></div>
     {tab==='catalog'&&<><div className="search"><Search size={15}/><input placeholder="查找脚本或测试用例" value={filter} onChange={e=>setFilter(e.target.value)}/></div>
     <div className="file-list">{shown.map(t=><button key={t.id} className={'file-item '+(selected?.id===t.id?'selected':'')} onClick={()=>openFile(t)}><FileCode2 size={16}/><span><b>{t.title}</b><small>{t.file}:{t.line}</small><small className="uid-tag">{t.uid}{t.uidStable?'':' ⚠'}</small></span><ChevronRight size={14}/></button>)}{!shown.length&&<div className="empty-small">暂无测试用例<br/>请导入已有 Playwright 项目</div>}</div></>}
     {tab==='runs'&&<div className="file-list">{projectRuns.map(r=><button className={'run-item '+(currentRun?.id===r.id?'selected':'')} key={r.id} onClick={()=>setRunDetail(r)}><span className={'status-dot '+r.status}/><span><b>{r.file||'全部测试'}</b><small>{formatTime(r.createdAt)}</small><small className="uid-tag">{r.uid}</small></span><small>{label[r.status]||r.status}</small></button>)}</div>}
     {tab==='trace'&&<div className="file-list">{lineage.requirements.map(r=><div key={r.uid} className="file-item"><BookOpen size={16}/><span><b>{r.title}</b><small>{r.uid}</small></span></div>)}{!lineage.requirements.length&&<div className="empty-small">项目 .aitest/requirements.json<br/>可加载需求与关联关系</div>}</div>}
     {tab==='architecture'&&<div className="sidebar-hint">Git 是唯一脚本来源；SQLite 和远程执行留到后续迭代。v0.1 存储为本地 JSON。</div>}
     <div className="sidebar-footer">{catalog.tests.length} tests · {catalog.files.length} files<br/><span>{selectedProject?.root||'未连接 Git 项目'}</span></div>
    </aside>
    <main className="content">
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
     {tab==='trace'&&<><div className="section-top"><div><div className="eyebrow">QUALITY LINEAGE</div><h1>需求与测试追踪</h1><p>Requirement → Script → Execution → Evidence 的可查询映射。</p></div></div><div className="card"><div className="card-title"><Network size={17}/> 关联矩阵</div><table><thead><tr><th>需求编号</th><th>需求名称</th><th>关联用例</th><th>覆盖情况</th></tr></thead><tbody>{lineage.requirements.map(req=>{const targets=lineage.links.filter(x=>x.from===req.uid).map(x=>x.to);return <tr key={req.uid}><td>{req.uid}</td><td>{req.title}</td><td>{targets.join(', ')||'—'}</td><td>{targets.length?'已建立关联':'待补充'}</td></tr>})}</tbody></table>{!lineage.requirements.length&&<p className="muted">在项目中建立 .aitest/requirements.json 和 traceability.json 后可显示需求关系。</p>}</div></>}
     {tab==='architecture'&&<><div className="section-top"><div><div className="eyebrow">DESIGN BASELINE</div><h1>架构与运行边界</h1><p>Git-native · Evidence-driven · Visual-first</p></div></div><div className="architecture"><div className="arch-card"><FolderGit2/><h3>Git / Playwright</h3><p>已有仓库与测试代码是事实来源</p></div><div className="arch-card"><Activity/><h3>Node Runner Bridge</h3><p>本机子进程启动、停止、结果采集</p></div><div className="arch-card"><Clock/><h3>Execution History</h3><p>本地存储运行日志与不可变证据</p></div><div className="arch-card"><BookOpen/><h3>IPA Traceability</h3><p>需求、脚本与执行结果的映射入口</p></div></div><div className="note"><ShieldAlert size={15}/> 安全限制：仅用于可信的本地项目。Node 子进程不是容器沙箱。暂未加入远程执行、RBAC、密钥保险箱或 AI 自动写回。</div></>}
    </main>
   </section>
   <footer className="bottom-bar"><span><span className="online"/> LOCAL RUNNER · 127.0.0.1:4577</span><span>Git as source · Evidence as record</span></footer>
  </div>
  {dialog&&<div className="overlay" onClick={()=>setDialog(false)}><div className="modal" onClick={e=>e.stopPropagation()}><h2>添加 Playwright 项目</h2><p>填写已有 Git 项目的本地绝对路径。系统不复制项目，也不会自动执行 npm install。</p><input autoFocus value={projectPath} onChange={e=>setProjectPath(e.target.value)} placeholder="C:\\Projects\\MyApp 或 /workspace/my-app"/><div className="modal-actions"><button className="btn secondary" onClick={()=>setDialog(false)}>取消</button><button className="btn primary" disabled={busy||!projectPath} onClick={addProject}>添加项目</button></div></div></div>}
  {message&&<div className="toast">{message}</div>}
 </div>
}
