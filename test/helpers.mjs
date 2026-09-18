import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, collect } from '../src/collector.mjs';
import { setup } from '../src/engine.mjs';
import { loadConfig, loadRegistry } from '../src/config.mjs';
import { emptyState } from '../src/store.mjs';
import { route } from '../src/router.mjs';
import { emptyLedger, MEMORY_PATH } from '../src/memory.mjs';
import { renderViews, projectionHashes } from '../src/views.mjs';
import { writeJson } from '../src/util.mjs';

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
  const ledger=emptyLedger(),views=renderViews(ledger,f.catalog,f.config);ledger.projections=projectionHashes(views,f.catalog);
  await writeJson(f.root,MEMORY_PATH,ledger);
  for(const [path,text] of Object.entries(views))await put(f.root,path,text);
  const snapshot=await collect(f.root,f.config,f.catalog);
  const state=emptyState();
  for(const j of route(snapshot,state,f.catalog,f.config)) state.documents[j.domain]={files:j.surface,sessions:{},sessionEpisodes:{},inputFingerprint:j.inputFingerprint,documentFingerprint:j.documentHash,ruleFingerprint:j.ruleFingerprint,churnHash:j.churnHash,lastCuratedCommit:snapshot.head,memoryFingerprint:j.memoryFingerprint,scarFingerprint:j.scarFingerprint};
  return {snapshot,state};
}
export function readAll(inv,id) {
  let start=0,read;
  do { read=inv.read(id,start);start=read.nextOffset; } while(start!==null);
  return read.ref;
}
export function complete(inv,{blocked=false,memoryOps,statement}={}) {
  const refs=[];
  for(const {id} of inv.list().evidence)refs.push(readAll(inv,id));
  const checks=[...inv.checks.values()];
  const missing=!inv.snapshot.ledger?.records.some(r=>r.domains.includes(inv.job.domain));
  const update=!blocked&&(missing||Boolean(memoryOps)||Boolean(statement));
  checks.forEach((c,i)=>inv.resolve({id:c.id,outcome:blocked&&i===0?'insufficient_evidence':update&&i===0?'update':'no_finding',finding:blocked&&i===0?'Required authoritative evidence is not available.':'The fixture evidence supports this recorded test outcome.',evidenceRefs:refs,confidence:'high',classification:'observed'}));
  const source=[...inv.receipts.values()].find(r=>r.id==='file:package.json')?.ref??refs[0];
  const ops=memoryOps??(update?{create:[{kind:'invariant',domains:[inv.job.domain],statement:statement??`Package metadata for ${inv.job.domain} is declared in package.json.`,scope:{global:true,paths:[],symbols:[],concepts:[]},checkIds:[checks[0].id],evidenceRefs:[source]}]}:{});
  inv.submit({summary:'Completed fixture investigation with verified evidence.',memoryOps:blocked?{}:ops});
  return {turns:1,usage:{input:0,output:0,cost:0},model:'fixture'};
}
