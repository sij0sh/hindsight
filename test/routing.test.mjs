import test from 'node:test';
import assert from 'node:assert/strict';
import { unlink, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture,baseline,put } from './helpers.mjs';
import { collect,git,captureSession } from '../src/collector.mjs';
import { route,schedule } from '../src/router.mjs';
import { hash,glob } from '../src/util.mjs';
import { validateRegistry } from '../src/config.mjs';

test('registry covers ten domains, stable criterion IDs, and complete trigger references',async t=>{
  const f=await fixture(t);validateRegistry(f.catalog);
  assert.equal(f.catalog.documents.length,10);
  assert.equal(f.catalog.documents.reduce((n,d)=>n+d.criteria.length,0),138);
  const bad=structuredClone(f.catalog);bad.documents[0].rules[0].checks.push('UNKNOWN');
  assert.throws(()=>validateRegistry(bad),/mapping/);
});
test('glob handles root and nested files, metacharacters, and path boundaries',()=>{
  assert.equal(glob('**/package.json','package.json'),true);
  assert.equal(glob('**/package.json','a/b/package.json'),true);
  assert.equal(glob('src/*','src/a/b'),false);
  assert.equal(glob('a[0].ts','a[0].ts'),true);
});
test('unchanged content skips all curators, including after a metadata-only commit',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  assert.ok(route(await collect(f.root,f.config,f.catalog),state,f.catalog,f.config).every(j=>j.status==='unchanged'));
  await git(f.root,['commit','--allow-empty','-qm','metadata only']);
  assert.ok(route(await collect(f.root,f.config,f.catalog),state,f.catalog,f.config).every(j=>j.status==='unchanged'));
});
test('dependency edits route dependencies/security as affected and architecture as candidate',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await put(f.root,'package.json','{"dependencies":{"example":"1.0.0"}}');
  const jobs=route(await collect(f.root,f.config,f.catalog),state,f.catalog,f.config);
  assert.equal(jobs.find(j=>j.domain==='dependencies').status,'affected');
  assert.equal(jobs.find(j=>j.domain==='security').status,'affected');
  assert.equal(jobs.find(j=>j.domain==='architecture').status,'candidate');
});
test('README typo does not route architecture or security',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await put(f.root,'README.md','A corrected spelling.');
  const jobs=route(await collect(f.root,f.config,f.catalog),state,f.catalog,f.config);
  assert.equal(jobs.find(j=>j.domain==='architecture').status,'unchanged');
  assert.equal(jobs.find(j=>j.domain==='security').status,'unchanged');
  assert.equal(jobs.find(j=>j.domain==='intent_and_contracts').status,'candidate');
});
test('missing document always routes, even with unchanged inputs',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await unlink(join(f.root,'.agents/engineering/ARCHITECTURE.md'));
  const job=route(await collect(f.root,f.config,f.catalog),state,f.catalog,f.config).find(j=>j.domain==='architecture');
  assert.equal(job.status,'missing');assert.equal(job.checks.length,21);
});
test('unstaged, staged-only, untracked, deleted, and renamed files are visible',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await put(f.root,'src/main.ts','export const answer=43;');await git(f.root,['add','src/main.ts']);
  await put(f.root,'src/main.ts','export const answer = 42;\n'); // index differs while worktree equals original
  await put(f.root,'src/new.ts','export const other=1;');
  let snap=await collect(f.root,f.config,f.catalog);
  let job=route(snap,state,f.catalog,f.config).find(j=>j.domain==='architecture');
  assert.ok(job.changedFiles.includes('src/main.ts'));assert.ok(job.changedFiles.includes('src/new.ts'));
  await rename(join(f.root,'src/main.ts'),join(f.root,'src/renamed.ts'));
  snap=await collect(f.root,f.config,f.catalog);job=route(snap,state,f.catalog,f.config).find(j=>j.domain==='architecture');
  assert.ok(job.changedFiles.includes('src/renamed.ts'));assert.equal(snap.files['src/main.ts'].missing,true);
});
test('generated outputs cannot trigger their own routing loop',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await put(f.root,'.agents/curation/random.json','{}');await put(f.root,'dist/app.js','generated');
  assert.ok(route(await collect(f.root,f.config,f.catalog),state,f.catalog,f.config).every(j=>j.status==='unchanged'));
});
test('manual edits and registry changes schedule reconciliation',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await put(f.root,'.agents/engineering/ARCHITECTURE.md','# Human guidance\n\nPreserve this explicit constraint.\n');
  let snap=await collect(f.root,f.config,f.catalog);let job=route(snap,state,f.catalog,f.config).find(j=>j.domain==='architecture');
  assert.equal(job.status,'candidate');assert.ok(job.triggers.some(t=>t.id==='manual-document-change'));
  f.catalog.documents.find(d=>d.id==='architecture').criteria[0].question+=' Updated criterion.';
  job=route(snap,state,f.catalog,f.config).find(j=>j.domain==='architecture');
  assert.equal(job.checks.length,21);assert.ok(job.triggers.some(t=>t.id==='rule-version-changed'));
});
test('lexical import changes produce a structural inspection, not an invented conclusion',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await put(f.root,'src/main.ts','import {x} from "./other.js"; export const answer=x;');
  const job=route(await collect(f.root,f.config,f.catalog),state,f.catalog,f.config).find(j=>j.domain==='architecture');
  assert.equal(job.status,'affected');assert.ok(job.triggers.some(t=>t.id==='import-surface'));
  assert.ok(job.checks.some(c=>c.id==='ARCH-CYCLE-001'));
});
test('incremental sessions track entry content, survive branching, and retain oversized evidence',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  const entry={id:'m1',type:'message',timestamp:'2026-09-17',message:{role:'user',content:'Always run the repository validation command.'}};
  await captureSession(f.root,'s1',[entry]);
  let snap=await collect(f.root,f.config,f.catalog);let job=route(snap,state,f.catalog,f.config).find(j=>j.domain==='agent_policy');
  assert.equal(job.pendingSessions,1);state.documents.agent_policy.sessions['session:s1:m1']=hash(entry.message.content);
  job=route(snap,state,f.catalog,f.config).find(j=>j.domain==='agent_policy');assert.equal(job.pendingSessions,0);
  entry.message.content='A revised explicit rule.';await captureSession(f.root,'s1',[entry]);await captureSession(f.root,'s1',[]);
  snap=await collect(f.root,f.config,f.catalog);job=route(snap,state,f.catalog,{...f.config,maxSessionBatchChars:5}).find(j=>j.domain==='agent_policy');
  assert.equal(job.pendingSessions,1);assert.equal(job.sessionBlocked,true);
});
test('sensitive content is hashed but withheld and symlinks never expose targets',async t=>{
  const f=await fixture(t);await put(f.root,'.env','PASSWORD=do-not-expose');
  await symlink(join(f.root,'.env'),join(f.root,'src/link.ts'));
  const snap=await collect(f.root,f.config,f.catalog);
  assert.equal(snap.contents.has('file:.env'),false);
  assert.equal(snap.files['.env'].unreadable,'sensitive input');
  assert.equal(snap.contents.has('file:src/link.ts'),false);
});
test('candidate aging prevents starvation and retry cooldown preserves pending work',()=>{
  const config={candidateDelayEvents:2,maxAutoJobs:1};const state={queue:{},tick:0};
  const old={domain:'old',routing:'inspect',status:'candidate',signature:'a'};
  assert.equal(schedule([old],state,config,{event:true}).length,0);
  schedule([old],state,config,{event:true});
  const newer={domain:'new',routing:'inspect',status:'affected',signature:'b'};
  assert.equal(schedule([old,newer],state,config,{event:true})[0].domain,'old');
  state.queue.old.retryAt=10;assert.equal(schedule([old],state,config).length,0);
  assert.equal(schedule([old],state,config,{manual:true})[0].domain,'old');
});
test('staged-only content is available independently from the working copy',async t=>{
  const f=await fixture(t);await put(f.root,'src/main.ts','export const answer = "STAGED";');await git(f.root,['add','src/main.ts']);
  await put(f.root,'src/main.ts','export const answer = 42;\n');
  const snap=await collect(f.root,f.config,f.catalog);
  assert.match(snap.contents.get('index:src/main.ts'),/STAGED/);
  assert.match(snap.contents.get('file:src/main.ts'),/42/);
});
test('staged deletion retains committed source evidence',async t=>{
  const f=await fixture(t);await git(f.root,['rm','src/main.ts']);
  const snap=await collect(f.root,f.config,f.catalog);
  assert.equal(snap.files['src/main.ts'].missing,true);assert.match(snap.contents.get('head:src/main.ts'),/42/);
});
test('churn counts repository history and crosses configured routing thresholds',async t=>{
  const f=await fixture(t);f.config.churnThreshold=3;const {state}=await baseline(f);
  for(let n=0;n<3;n++){await put(f.root,'src/main.ts',`export const n=${n};`);await git(f.root,['add','src/main.ts']);await git(f.root,['commit','-qm',`change ${n}`]);}
  const snap=await collect(f.root,f.config,f.catalog);assert.equal(snap.churn['src/main.ts'],4);
  const job=route(snap,state,f.catalog,f.config).find(j=>j.domain==='maintainability');assert.ok(job.triggers.some(t=>t.id==='churn-hotspot'));
});
test('tracked secret configuration changes route relevant domains without exposing values',async t=>{
  const f=await fixture(t,{'.env':'TOKEN=first','package.json':'{}'});const {state}=await baseline(f);await put(f.root,'.env','TOKEN=second');
  const snap=await collect(f.root,f.config,f.catalog);const jobs=route(snap,state,f.catalog,f.config);
  assert.equal(jobs.find(j=>j.domain==='security').status,'affected');assert.equal(snap.contents.has('file:.env'),false);assert.equal(snap.contents.has('head:.env'),false);
});
test('unborn Git repositories are supported',async t=>{
  const f=await fixture(t);await git(f.root,['checkout','--orphan','unborn']);await git(f.root,['rm','-rf','.']);await put(f.root,'src/first.ts','export const first=true;');
  const snap=await collect(f.root,f.config,f.catalog);assert.equal(snap.head,null);assert.ok(snap.files['src/first.ts']);
});
