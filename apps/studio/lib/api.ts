export type Project={id:string,uid:string,name:string,root:string,addedAt:string,git:{branch:string,commit:string,dirty:boolean}};
export type TestDef={id:string,uid:string,uidSource:string,uidStable:boolean,file:string,title:string,line:number,source:string,level:string,ambiguity?:{key:string,reason:string,candidates:{file:string,title:string,line:number}[]}};
export type TestCatalog={tests:TestDef[],files:string[],warning:string,uidVersion:number,projectUid:string};
export type Attempt={uid:string,runUid:string,testUid:string|null,uidBasis:string,file:string,title:string,line:number|null,retry:number,status:string,caseStatus:string,duration:number,error:string};
export type Run={id:string,uid:string,seq:number,projectId:string,projectUid:string,projectName:string,file:string|null,gitCommit:string,status:string,createdAt:string,startedAt:string|null,finishedAt:string|null,log?:string,error?:string,summary?:{passed:number,failed:number,skipped:number,flaky:number,total:number,executions:number,cases:{title:string,file:string,status:string,resultStatus:string,duration:number,error:string}[]},artifacts?:{file:string,size:number,sha256:string}[],attempts?:Attempt[]};
export type Source={file:string,content:string,hash:string};
// ATS-402: the AI data security surface. A credential reference NEVER
// carries the secret -- only the name, the provider and a short
// fingerprint the user can compare by eye.
export type CredentialRef={id:string,name:string,purpose:string,provider:string,fingerprint:string,createdAt:string,updatedAt:string};
export type EgressScopeItem={kind:string,ref:string,digest:string,bytes:number};
export type EgressScope={kinds:string[],count:number,totalBytes:number,items:EgressScopeItem[],scopeDigest:string};
export type EgressPreview={previewId:string,scope:EgressScope,note:string};
export type EgressConsent={id:string,contract:string,kinds:string[],scopeDigest:string,itemCount:number,totalBytes:number,createdAt:string,expiresAt:string,state:string,revokedAt:string|null};
export type SecurityContract={contract:string,provider:string,purposes:string[],errorCodes:string[],note:string,egressConsent:{contract:string,kinds:string[],states:string[],errorCodes:string[],defaultTtlSeconds:number,maxTtlSeconds:number,flow:string,note:string}};
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
