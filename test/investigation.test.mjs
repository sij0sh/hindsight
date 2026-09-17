import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,baseline,readAll,complete } from './helpers.mjs';
import { route } from '../src/router.mjs';
import { Investigation } from '../src/investigation.mjs';
import { collect,git,captureSession } from '../src/collector.mjs';
import { put } from './helpers.mjs';

async function ledger(t) { const f=await fixture(t);const {snapshot,state}=await baseline(f);const job=route(snapshot,state,f.catalog,f.config,{force:true,domain:'architecture'})[0];return new Investigation(job,snapshot,f.config); }
const outcome=(id,refs=[])=>({id,outcome:'no_finding',finding:'Evidence supports the existing documented behavior.',evidenceRefs:refs,classification:'observed',confidence:'high'});
test('unresolved mandatory checks and invented evidence cannot pass completion',async t=>{
  const inv=await ledger(t);assert.throws(()=>inv.submit({summary:'All checks are done.'}),/every required/);
  const id=[...inv.checks.keys()][0];assert.throws(()=>inv.resolve(outcome(id,['E999'])),/receipt/);
  assert.throws(()=>inv.resolve(outcome(id)),/inspected evidence/);
});
test('derived checks need ancestry, a reason, bounded count, and completion',async t=>{
  const inv=await ledger(t);const parent=[...inv.checks.keys()][0];
  assert.throws(()=>inv.add({id:'DERIVED-1',parent:'invalid',question:'Where is state owned?',reason:'A new state boundary was discovered.'}),/parent/);
  inv.add({id:'DERIVED-1',parent,question:'Where is state owned?',reason:'A new state boundary was discovered.'});
  assert.equal(inv.checks.get('DERIVED-1').status,'pending');
  assert.throws(()=>inv.submit({summary:'Incomplete derived check.'}),/every required/);
});
test('brainstorm and request cannot be promoted to a durable rule',async t=>{
  const inv=await ledger(t);const ref=readAll(inv,'manifest');const id=[...inv.checks.keys()][0];
  assert.throws(()=>inv.resolve({...outcome(id,[ref]),outcome:'update',classification:'brainstorm'}),/canonical policy/);
});
test('every canonical document must be read before a successful submission',async t=>{
  const inv=await ledger(t);const ref=readAll(inv,'manifest');
  for(const id of inv.checks.keys()) inv.resolve(outcome(id,[ref]));
  assert.throws(()=>inv.submit({summary:'No canonical changes are required.',patches:[]}),/Cross-document/);
});
test('partial chunks do not count as reading a document',async t=>{
  const inv=await ledger(t);inv.read('doc:architecture',0,5);assert.equal(inv.fullyRead('doc:architecture'),false);
  readAll(inv,'doc:architecture');assert.equal(inv.fullyRead('doc:architecture'),true);
});
test('exact patches preserve unrelated human guidance and cannot use ambiguous targets',async t=>{
  const inv=await ledger(t);complete(inv,{patch:{oldText:'Fixture knowledge',newText:'Updated fixture knowledge'}});
  assert.ok(inv.submission.nextDocument.includes('Updated fixture knowledge preserved'));
  assert.equal(inv.submission.result,'updated');
  const other=await ledger(t);assert.throws(()=>complete(other,{patch:{oldText:'not present',newText:'replace'}}),/exactly once/);
});
test('insufficient evidence blocks canonical changes and freshness',async t=>{
  const inv=await ledger(t);complete(inv,{blocked:true});assert.equal(inv.submission.result,'blocked');
});
test('conflicts remain blocked and obvious violations cannot become ADR tradeoffs',async t=>{
  const inv=await ledger(t);const ref=readAll(inv,'manifest');const first=[...inv.checks.keys()][0];
  for(const id of inv.checks.keys()) inv.resolve({...outcome(id,[ref]),...(id===first?{outcome:'conflict',classification:'violation'}:{})});
  assert.throws(()=>inv.submit({summary:'A missing control must be fixed.',adrs:[{title:'Bypass policy',context:'Missing control',options:['keep','remove'],checkIds:[first]}]}),/not clear violations/);
  inv.submit({summary:'A missing control must be fixed.',patches:[]});assert.equal(inv.submission.result,'blocked');
});
test('ADR candidates must have an explicit proposed decision with alternatives',async t=>{
  const inv=await ledger(t);const ref=readAll(inv,'manifest');const first=[...inv.checks.keys()][0];
  for(const id of inv.checks.keys()) inv.resolve({...outcome(id,[ref]),...(id===first?{outcome:'adr_candidate',classification:'tradeoff'}:{})});
  assert.throws(()=>inv.submit({summary:'A decision is required here.'}),/needs a proposal/);
  inv.submit({summary:'A decision is required here.',adrs:[{title:'Choose state owner',context:'Two plausible owners remain.',options:['Database','External service'],checkIds:[first]}]});
  assert.equal(inv.submission.result,'blocked');
});
test('unread differing index evidence cannot be acknowledged as current',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await put(f.root,'package.json','{"name":"staged-change"}');await git(f.root,['add','package.json']);await put(f.root,'package.json','{"name":"working-copy"}');
  const snapshot=await collect(f.root,f.config,f.catalog);const inv=new Investigation(route(snapshot,state,f.catalog,f.config,{domain:'dependencies'})[0],snapshot,f.config);
  let ref;
  for(const {id} of inv.list().evidence) if(!id.startsWith('index:')) ref=readAll(inv,id);
  for(const id of inv.checks.keys()) inv.resolve(outcome(id,[ref]));
  assert.throws(()=>inv.submit({summary:'These inputs do not change durable knowledge.'}),/differing Git layer/);
});
test('unread session entries cannot advance a session watermark',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await captureSession(f.root,'s1',[{type:'message',id:'new',timestamp:'2026',message:{role:'user',content:'This is an explicit repository constraint.'}}]);
  const snapshot=await collect(f.root,f.config,f.catalog);const inv=new Investigation(route(snapshot,state,f.catalog,f.config,{domain:'agent_policy'})[0],snapshot,f.config);
  let ref;
  for(const {id} of inv.list().evidence) if(!id.startsWith('session:')) ref=readAll(inv,id);
  for(const id of inv.checks.keys()) inv.resolve(outcome(id,[ref]));
  assert.throws(()=>inv.submit({summary:'These inputs do not change durable knowledge.'}),/unread session/);
});
