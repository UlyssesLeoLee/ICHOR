export type Project={id:string,uid:string,name:string,root:string,addedAt:string,git:{branch:string,commit:string,dirty:boolean}};
// ATS-602: a mobile Flow case is a TestDefinition like every other case.
// The `steps` and the `engine` are what tell the UI that the case runs on
// a device rather than in a browser; a case without them is a web case.
export type MobileStep={kind:string,args:Record<string,unknown>,assertion:Record<string,unknown>|null,line:number,raw:string};
export type TestDef={id:string,uid:string,uidSource:string,uidStable:boolean,file:string,title:string,line:number,source:string,level:string,ambiguity?:{key:string,reason:string,candidates:{file:string,title:string,line:number}[]},engine?:string,appId?:string|null,tags?:string[],steps?:MobileStep[],unsupportedCount?:number};
// ATS-602: the import report of every Flow file of the project. A step the
// platform cannot run is reported here with its original text, its line and
// the reason -- it is never dropped silently.
export type FlowImportReport={file:string,syntax:string|null,appId:string|null,cases:number,mappedSteps:number,unsupportedSteps:number,unsupportedByReason:Record<string,number>,warnings:number,errors:number,unsupportedSteps_detail:{file:string,line:number,raw:string,command:string,reason:string,reasonText:string,suggestion:string|null}[],warnings_detail:{line:number,message:string,raw:string}[],errors_detail:{line:number,message:string}[]};
export type MobileSection={files:string[],cases:number,unsupportedSteps:number,errors:number,imports:FlowImportReport[]};
export type TestCatalog={tests:TestDef[],files:string[],warning:string,uidVersion:number,projectUid:string,mobile?:MobileSection};
// ATS-214: the SELECTION -- the set of cases the user picked for a batch
// run. The snapshot is SELF-CONTAINED: it carries the file, the title and
// the line of every selected case, so the record can be read on its own
// after the catalogue has changed.
export type SelectionCase={uid:string,file:string,title:string,line:number|null};
export type SelectionSnapshot={uids:string[],cases:SelectionCase[],count:number,unknown:string[],at?:string};
// ATS-214: the BATCH -- the record of a selection that spanned several
// files. The engine takes at most ONE test-file filter (ATS-106's
// argument baseline), so the batch is one run per file, chained.
export type BatchGroup={file:string,uids:string[],count:number};
export type BatchRun={runId:string,file:string,groupIndex:number,status:string};
export type Batch={uid:string,projectId:string,projectUid:string,selectionUid:string,uids:string[],cases:SelectionCase[],files:string[],groups:BatchGroup[],status:string,createdAt:string,finishedAt:string|null,runs:BatchRun[],error?:string};
// ATS-214: the run carries the selection it was started for.
export type RunSelection={uids:string[],cases:SelectionCase[],count:number,files:string[],groups:BatchGroup[]};
export type Attempt={uid:string,runUid:string,testUid:string|null,uidBasis:string,file:string,title:string,line:number|null,retry:number,status:string,caseStatus:string,duration:number,error:string};
// ATS-208: the attempt of a case -- ONE execution of it. A case that was
// retried has SEVERAL attempts, and the first one is not overwritten by the
// retry.
export type CaseAttempt={status:string,retry:number,duration:number,error:string};
// ATS-208: the case as a whole. Its status is the AGGREGATE of its
// attempts: a case that failed once and then passed is 'flaky'.
// ATS-216: the case also carries its IDENTITY -- the describe path, the
// line and the case key -- so that two same-titled cases of one file are
// two cases and not one.
export type CaseResult={title:string,file:string,status:string,duration:number,error:string,attemptsCount:number,scope?:string[],line?:number|null,column?:number|null,caseKey?:string|null,attempts:CaseAttempt[]};
export type Run={id:string,uid:string,seq:number,projectId:string,projectUid:string,projectName:string,file:string|null,gitCommit:string,status:string,createdAt:string,startedAt:string|null,finishedAt:string|null,log?:string,error?:string,summary?:{passed:number,failed:number,skipped:number,flaky:number,total:number,executions:number,cases:CaseResult[]},artifacts?:{file:string,size:number,sha256:string}[],attempts?:Attempt[],
// ATS-214: the SELECTION the run was started for, and the batch it is a
// part of. Both are on the record so that "what was selected" and "what
// ran" can be compared after the fact.
selection?:RunSelection,selectionUids?:string[],batchUid?:string,batchIndex?:number};
export type Source={file:string,content:string,hash:string};
// ATS-402: the AI data security surface. A credential reference NEVER
// carries the secret -- only the name, the provider and a short
// fingerprint the user can compare by eye.
export type CredentialRef={id:string,name:string,purpose:string,provider:string,fingerprint:string,createdAt:string,updatedAt:string};
export type EgressScopeItem={kind:string,ref:string,digest:string,bytes:number};
export type EgressScope={kinds:string[],count:number,totalBytes:number,items:EgressScopeItem[],scopeDigest:string};
export type EgressPreview={previewId:string,scope:EgressScope,note:string};
export type EgressConsent={id:string,contract:string,kinds:string[],scopeDigest:string,itemCount:number,totalBytes:number,createdAt:string,expiresAt:string,state:string,revokedAt:string|null};
export type SecurityContract={contract:string,provider:string,purposes:string[],errorCodes:string[],note:string,egressConsent:{contract:string,kinds:string[],states:string[],errorCodes:string[],defaultTtlSeconds:number,maxTtlSeconds:number,flow:string,note:string},egressAudit:{contract:string,events:string[],cap:number,note:string}};
// ATS-402: an audit record names the refs and their digests (digest is null for a refusal: no file was read). It never carries the content.
export type EgressAuditItem={kind:string,ref:string,digest:string|null,bytes:number};
export type EgressAuditRecord={id:string,at:string,event:string,outcome:string,code:string|null,reason:string|null,consentId:string|null,projectId:string|null,kinds:string[],itemCount:number,totalBytes:number,scopeDigest:string|null,items:EgressAuditItem[]};
// ATS-215: the EVIDENCE WORKBENCH. The endpoint hands over the FACTS; the
// shared module (apps/studio/public/evidence-workbench.mjs) turns them
// into the view. Both interfaces import that one module, so the two UIs
// cannot disagree about where a case's trace is.
export type EvidenceAttachment={file:string,size:number|null,sha256:string|null,modifiedAt:string|null,kind?:string};
export type EvidenceCaseAttachment={name:string,contentType:string,file:string};
export type EvidenceCase={title:string,file:string,line:number|null,status:string,duration:number|null,error:string,attemptsCount:number|null,scope?:string[],caseKey?:string|null,attachments?:EvidenceCaseAttachment[]};
export type EvidenceVerification={verified:boolean,ok:boolean,checked:number,missing:string[],changed:{file:string,expected:string,actual:string}[],reason:string|null};
export type EvidenceMaterial={run:{id:string,uid:string|null,status:string|null,gitCommit:string|null,runner:string|null,startedAt:string|null,finishedAt:string|null,createdAt:string|null,engineVersion:string|null},artifacts:EvidenceAttachment[],cases:EvidenceCase[],verification:EvidenceVerification|null};
// The view the shared module computes from the material.
export type WorkbenchFailure={title:string,file:string,line:number|null,status:string,error:string,duration:number|null,attemptsCount:number|null,trace:EvidenceAttachment|null,traceLocated:boolean,traceSource:string,traceReason:string,attachments:EvidenceAttachment[],clickPath:{steps:{action:string,label:string}[],clicks:number,budget:number,withinBudget:boolean}};
export type WorkbenchView={runId:string|null,runUid:string|null,runStatus:string|null,gitCommit:string|null,runner:string|null,startedAt:string|null,finishedAt:string|null,engineVersion:string|null,failureCount:number,failures:WorkbenchFailure[],attachments:EvidenceAttachment[],totals:{count:number,bytes:number,failures:number,locatedTraces:number},verification:EvidenceVerification|null,clickBudget:number};
const root=()=>typeof window!=='undefined' && window.location.port==='4577'?'':'http://127.0.0.1:4577';
let token='';
export async function api<T>(url:string,method='GET',payload?:unknown):Promise<T>{
 if(!token){const r=await fetch(root()+'/api/session');if(!r.ok)throw Error('无法连接本地执行服务。请先运行 npm start');token=(await r.json()).token;}
 const r=await fetch(root()+url,{method,headers:{'X-ATS-Token':token,'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload)});
 const value=await r.json();if(!r.ok)throw Error(value.error||`HTTP ${r.status}`);return value as T;
}
export const artifactUrl=(id:string,file:string,sessionToken:string)=>root()+`/api/runs/${id}/artifact?file=${encodeURIComponent(file)}`;
// Download attachments with a scoped request header rather than public URLs.
export async function downloadArtifact(id:string,file:string){
 if(!token)await api('/api/health');
 const r=await fetch(root()+`/api/runs/${id}/artifact?file=${encodeURIComponent(file)}`,{headers:{'X-ATS-Token':token}});if(!r.ok)throw new Error('下载失败');
 const blob=await r.blob(),obj=URL.createObjectURL(blob),a=document.createElement('a');a.href=obj;a.download=file.split('/').pop()||'artifact';a.click();URL.revokeObjectURL(obj);
}
/**
 * ATS-111: a CANCELLABLE request.
 *
 * The plain `api()` above cannot be cancelled: once the fetch is in
 * flight the caller has no way to say "I no longer want this answer".
 * That is what makes the CANCELLED state un-representable in the UI --
 * a panel whose project was switched, or whose reader navigated away,
 * would still be stuck waiting for the old answer, and the reader could
 * not tell "still loading" from "the request I abandoned is still
 * loading".
 *
 * `cancellableApi` therefore hands back a handle that carries BOTH the
 * promise and an `abort()`. Aborting is reported as a CANCELLATION, not
 * as a failure: the caller sees `cancelled: true`, and the rejection is
 * the AbortError itself, so the UI can show the cancelled state rather
 * than the failure state.
 *
 * The four states of a workbench panel are mapped from this handle by
 * `apps/studio/lib/workbench-state.mjs` -- one model, one place.
 */
export type CancellableRequest<T>={promise:Promise<T>,abort:()=>void,cancelled:()=>boolean};
/**
 * The handle is returned SYNCHRONOUSLY -- it is not an `async` function
 * wrapped in a promise, because the caller must be able to call
 * `abort()` on it IMMEDIATELY, before the first await in its own body.
 * A promise-of-a-handle would arrive one microtask too late to cancel
 * the request it is meant to cancel.
 *
 * The session token is therefore fetched lazily INSIDE the promise: the
 * handle exists before the token does, and `abort()` works from the very
 * first moment.
 */
export function cancellableApi<T>(url:string,method='GET',payload?:unknown):CancellableRequest<T>{
 const controller=new AbortController();
 let cancelled=false;
 const promise=(async()=>{
  if(!token){const r=await fetch(root()+'/api/session');if(!r.ok)throw Error('无法连接本地执行服务。请先运行 npm start');token=(await r.json()).token;}
  const r=await fetch(root()+url,{method,signal:controller.signal,headers:{'X-ATS-Token':token,'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload)});
  const value=await r.json();if(!r.ok)throw Error(value.error||`HTTP ${r.status}`);return value as T;
 })();
 // An abort must not surface as an unhandled rejection: the caller
 // awaits the promise and decides what an abort means, so the rejection
 // is delivered to whoever awaits it (and to nobody else).
 promise.catch(()=>{});
 return {promise,abort:()=>{cancelled=true;controller.abort();},cancelled:()=>cancelled};
}

