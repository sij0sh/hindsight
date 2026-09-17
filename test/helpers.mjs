import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, collect } from '../src/collector.mjs';
import { setup } from '../src/engine.mjs';
import { loadConfig, loadRegistry } from '../src/config.mjs';
import { emptyState } from '../src/store.mjs';
import { route } from '../src/router.mjs';

const tempRoot = new URL('../.test-work/',import.meta.url);
export async function fixture(t,files={'src/main.ts':'export const answer = 42;\n','package.json':'{"name":"fixture","version":"1.0.0"}\n'}) {
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(join(tempRoot.pathname,'repo-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await git(root,['init','-q']);
  await git(root,['config','user.email','fixture@example.invalid']);
  await git(root,['config','user.name','Fixture']);
  for(const [path,text] of Object.entries(files)) await put(root,path,text);
  await git(root,['add','.']); await git(root,['commit','-qm','fixture']);
  await setup(root);
  const {config}=await loadConfig(root); const {catalog}=await loadRegistry(root);
  return {root,config,catalog};
}
export async function put(root,path,text) { await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),text); }
export async function baseline(f) {
  for(const d of f.catalog.documents) await put(f.root,d.path,`# ${d.id}\n\nFixture knowledge preserved for regression tests.\n`);
  const snapshot=await collect(f.root,f.config,f.catalog);
  const state=emptyState();
  for(const j of route(snapshot,state,f.catalog,f.config)) state.documents[j.domain]={files:j.surface,sessions:{},inputFingerprint:j.inputFingerprint,documentFingerprint:j.documentHash,ruleFingerprint:j.ruleFingerprint,churnHash:j.churnHash,lastCuratedCommit:snapshot.head};
  return {snapshot,state};
}
export function readAll(inv,id) {
  let start=0,read;
  do { read=inv.read(id,start);start=read.nextOffset; } while(start!==null);
  return read.ref;
}
export function complete(inv,{patch,blocked=false,newDocument}={}) {
  const refs=[];
  for(const {id} of inv.list().evidence) refs.push(readAll(inv,id));
  const checks=[...inv.checks.values()];
  const missing=inv.snapshot.documents[inv.job.domain].content===null;
  checks.forEach((c,i)=>inv.resolve({id:c.id,outcome:blocked&&i===0?'insufficient_evidence':(missing||patch)&&i===0?'update':'no_finding',finding:blocked&&i===0?'Required authoritative evidence is not available.':'The fixture evidence supports this recorded test outcome.',evidenceRefs:refs,confidence:'high',classification:'observed'}));
  inv.submit({summary:'Completed fixture investigation with verified evidence.',...(blocked?{}:missing?{newDocument:newDocument??`# ${inv.job.domain}\n\nPackage metadata is defined in package.json.\n`}:patch?{patches:[{...patch,checkIds:[checks[0].id]}]}:{patches:[]})});
  return {turns:1,usage:{input:0,output:0,cost:0},model:'fixture'};
}
