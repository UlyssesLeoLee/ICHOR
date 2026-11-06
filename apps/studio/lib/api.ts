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
export type Attempt={uid:string,runUid:string,testUid:string|null,uidBasis:string,file:string,title:string,line:number|null,retry:number,status:string,caseStatus:string,duration:number,error:string};
// ATS-208: the attempt of a case -- ONE execution of it. A case that was
// retried has SEVERAL attempts, and the first one is not overwritten by the
// retry.
export type CaseAttempt={status:string,retry:number,duration:number,error:string};
// ATS-208: the case as a whole. Its status is the AGGREGATE of its
// attempts: a case that failed once and then passed is 'flaky'.
export type CaseResult={title:string,file:string,status:string,duration:number,error:string,attemptsCount:number,attempts:CaseAttempt[]};
export type Run={id:string,uid:string,seq:number,projectId:string,projectUid:string,projectName:string,file:string|null,gitCommit:string,status:string,createdAt:string,startedAt:string|null,finishedAt:string|null,log?:string,error?:string,summary?:{passed:number,failed:number,skipped:number,flaky:number,total:number,executions:number,cases:CaseResult[]},artifacts?:{file:string,size:number,sha256:string}[],attempts?:Attempt[]};
export type Source={file:string,content:string,hash:string};
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
