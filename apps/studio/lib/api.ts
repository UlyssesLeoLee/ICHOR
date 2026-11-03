export type Project={id:string,name:string,root:string,addedAt:string,git:{branch:string,commit:string,dirty:boolean}};
export type TestDef={id:string,file:string,title:string,line:number,source:string,level:string};
export type TestCatalog={tests:TestDef[],files:string[],warning:string};
export type Run={id:string,projectId:string,projectName:string,file:string|null,gitCommit:string,status:string,createdAt:string,startedAt:string|null,finishedAt:string|null,log?:string,error?:string,summary?:{passed:number,failed:number,skipped:number,flaky:number,total:number,cases:{title:string,file:string,status:string,duration:number,error:string}[]},artifacts?:{file:string,size:number,sha256:string}[]};
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
