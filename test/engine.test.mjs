import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,symlink,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture,put,complete,baseline } from './helpers.mjs';
import { run,inspect,setup,capture } from '../src/engine.mjs';
import { loadState,withLock,commit,recover } from '../src/store.mjs';
import { hash,readJson,writeJson,safePath } from '../src/util.mjs';
import { STATE_PATH } from '../src/config.mjs';

test('all ten missing documents are created and second run makes zero model calls',async t=>{
  const f=await fixture(t);let calls=0;
  const result=await run(f.root,{curator:async inv=>{calls++;return complete(inv);}});
  assert.equal(calls,10);assert.ok(result.results.every(r=>r.result==='updated'));
  const next=await run(f.root,{curator:()=>{throw new Error('Must not invoke unchanged curator');}});
  assert.equal(next.results.length,0);
  assert.ok((await inspect(f.root)).jobs.every(j=>j.status==='unchanged'));
});
test('no_change advances the input baseline and prevents repeated inspection',async t=>{
  const f=await fixture(t);
  await run(f.root,{domain:'dependencies',curator:complete});
  await put(f.root,'package.json','{"name":"fixture","version":"1.0.1"}');
  const result=await run(f.root,{domain:'dependencies',curator:complete});
  assert.equal(result.results[0].result,'no_change');
  const view=await inspect(f.root,{domain:'dependencies'});assert.equal(view.jobs[0].status,'unchanged');
});
test('failure and blocked reports never advance document or session state',async t=>{
  const f=await fixture(t);
  let result=await run(f.root,{domain:'dependencies',curator:()=>{throw new Error('Model transport failed');}});
  assert.equal(result.results[0].result,'failed');assert.equal((await loadState(f.root)).documents.dependencies,undefined);
  result=await run(f.root,{domain:'dependencies',curator:inv=>complete(inv,{blocked:true})});
  assert.equal(result.results[0].result,'blocked');assert.equal((await loadState(f.root)).documents.dependencies,undefined);
  assert.ok((await readJson(f.root,result.results[0].reportPath)).checks.some(c=>c.outcome==='insufficient_evidence'));
});
test('manual document edits during investigation cannot be overwritten',async t=>{
  const f=await fixture(t);await run(f.root,{domain:'dependencies',curator:complete});
  const human='# Human decision\n\nThis explicitly supplied constraint must survive.\n';
  const result=await run(f.root,{domain:'dependencies',force:true,curator:async inv=>{
    const metrics=complete(inv,{statement:'Dependency metadata changed according to the package manifest.'});
    await put(f.root,'.agents/engineering/DEPENDENCIES.md',human);return metrics;
  }});
  assert.equal(result.results[0].result,'failed');
  assert.equal(await readFile(join(f.root,'.agents/engineering/DEPENDENCIES.md'),'utf8'),human);
});
test('source or unrelated canonical changes invalidate a proposal before commit',async t=>{
  const f=await fixture(t);
  let result=await run(f.root,{domain:'dependencies',curator:async inv=>{const metrics=complete(inv);await put(f.root,'src/main.ts','Changed after evidence capture.');return metrics;}});
  assert.equal(result.results[0].result,'failed');assert.equal((await loadState(f.root)).documents.dependencies,undefined);
  result=await run(f.root,{domain:'dependencies',curator:async inv=>{const metrics=complete(inv);await put(f.root,'.agents/engineering/SECURITY.md','# Human note\n\nA material security constraint.');return metrics;}});
  assert.equal(result.results[0].result,'failed');
});
test('per-domain incremental session processing only acknowledges the inspected batch',async t=>{
  const f=await fixture(t);
  const config=await readJson(f.root,'.agents/curation/config.json');config.maxSessionBatchChars=65;
  await writeJson(f.root,'.agents/curation/config.json',config);
  const events=[1,2,3].map(n=>({type:'message',id:`m${n}`,timestamp:`2026-09-17T00:00:0${n}Z`,message:{role:'user',content:`Explicit durable repository-specific user instruction number ${n}.`}}));
  await capture(f.root,'s1',events);
  await run(f.root,{domain:'agent_policy',curator:complete});
  let state=await loadState(f.root);assert.equal(Object.keys(state.documents.agent_policy.sessions).length,1);
  assert.equal((await inspect(f.root,{domain:'agent_policy'})).jobs[0].pendingSessions,2);
  await run(f.root,{domain:'agent_policy',curator:complete});await run(f.root,{domain:'agent_policy',curator:complete});
  state=await loadState(f.root);assert.equal(Object.keys(state.documents.agent_policy.sessions).length,3);
  assert.equal((await inspect(f.root,{domain:'agent_policy'})).jobs[0].status,'unchanged');
});
test('concurrent curation runs are rejected and lock releases on error',async t=>{
  const f=await fixture(t);
  await withLock(f.root,async()=>{await assert.rejects(()=>withLock(f.root,async()=>{}),/holds run.lock/);});
  await assert.rejects(()=>withLock(f.root,async()=>{throw new Error('expected');}),/expected/);
  await withLock(f.root,async()=>{});
});
test('transaction recovery completes a document-written/state-not-written interruption',async t=>{
  const f=await fixture(t);const path='.agents/engineering/DEPENDENCIES.md';const next='# Dependencies\n\nRecovered durable knowledge.\n';
  const nextState={version:1,documents:{},queue:{},tick:42};
  await writeJson(f.root,'.agents/curation/transaction.json',{version:1,path,expectedDocumentHash:null,nextContent:next,expectedStateHash:null,nextState,reportPath:'fixture'});
  await put(f.root,path,next);await recover(f.root);
  assert.equal((await loadState(f.root)).tick,42);assert.equal(await readJson(f.root,'.agents/curation/transaction.json'),null);
});
test('transaction recovery refuses to overwrite a human edit after a crash',async t=>{
  const f=await fixture(t);const path='.agents/engineering/DEPENDENCIES.md';
  await writeJson(f.root,'.agents/curation/transaction.json',{version:1,path,expectedDocumentHash:null,nextContent:'# Dependencies\n\nProposed knowledge.',expectedStateHash:null,nextState:{version:1,documents:{},queue:{},tick:1},reportPath:'fixture'});
  await put(f.root,path,'# Human note\n\nPreserve this post-crash edit.');
  await assert.rejects(()=>recover(f.root),/manually edited/);
});
test('unsafe output paths and symlink ancestors are rejected',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>safePath(f.root,'../outside'),/Unsafe/);
  await symlink(join(f.root,'src'),join(f.root,'alias'));
  await assert.rejects(()=>safePath(f.root,'alias/main.ts'),/Symlink/);
});
test('setup preserves human AGENTS content and is idempotent',async t=>{
  const f=await fixture(t);await put(f.root,'AGENTS.md','# Project instructions\n\nPreserve this exact line.\n');
  await setup(f.root);const first=await readFile(join(f.root,'AGENTS.md'),'utf8');await setup(f.root);
  assert.equal(await readFile(join(f.root,'AGENTS.md'),'utf8'),first);assert.ok(first.startsWith('# Project instructions\n\nPreserve this exact line.\n'));
});
test('corrupt state fails closed rather than silently resetting freshness',async t=>{
  const f=await fixture(t);await put(f.root,STATE_PATH,'{broken JSON');await assert.rejects(()=>inspect(f.root),/Invalid JSON/);
});
test('automatic scan advances deterministic queue without calling the SDK',async t=>{
  const f=await fixture(t);const result=await run(f.root,{manual:false,event:true,scanOnly:true,curator:()=>{throw new Error('Should not run');}});
  assert.equal(result.results.length,0);assert.equal((await loadState(f.root)).tick,1);assert.equal(Object.keys((await loadState(f.root)).queue).length,10);
});
