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
  assert.throws(()=>inv.submit({summary:'No canonical changes are required.',memoryOps:{}}),/Cross-document/);
});
test('partial chunks do not count as reading a document',async t=>{
  const inv=await ledger(t);inv.read('doc:architecture',0,5);assert.equal(inv.fullyRead('doc:architecture'),false);
  readAll(inv,'doc:architecture');assert.equal(inv.fullyRead('doc:architecture'),true);
});
test('legacy patches are rejected and valid operations produce a ledger proposal',async t=>{
  const inv=await ledger(t);complete(inv);assert.equal(inv.submission.result,'updated');assert.equal(inv.proposedLedger.records.length,1);
  const other=await ledger(t);const refs=[];for(const {id} of other.list().evidence)refs.push(readAll(other,id));
  for(const id of other.checks.keys())other.resolve(outcome(id,refs));
  assert.throws(()=>other.submit({summary:'Attempt an obsolete Markdown write.',patches:[]}),/memoryOps only/);
});
test('insufficient evidence blocks canonical changes and freshness',async t=>{
  const inv=await ledger(t);complete(inv,{blocked:true});assert.equal(inv.submission.result,'blocked');
});
test('conflicts remain blocked and obvious violations cannot become ADR tradeoffs',async t=>{
  const inv=await ledger(t);const ref=readAll(inv,'manifest');const first=[...inv.checks.keys()][0];
  for(const id of inv.checks.keys()) inv.resolve({...outcome(id,[ref]),...(id===first?{outcome:'conflict',classification:'violation'}:{})});
  assert.throws(()=>inv.submit({summary:'A missing control must be fixed.',adrs:[{title:'Bypass policy',context:'Missing control',options:['keep','remove'],checkIds:[first]}]}),/not clear violations/);
  inv.submit({summary:'A missing control must be fixed.',memoryOps:{}});assert.equal(inv.submission.result,'blocked');
});
test('ADR candidates must have an explicit proposed decision with alternatives',async t=>{
  const inv=await ledger(t);const ref=readAll(inv,'manifest');const first=[...inv.checks.keys()][0];
  readAll(inv,'memory-index');
  for(const id of inv.checks.keys()) inv.resolve({...outcome(id,[ref]),...(id===first?{outcome:'adr_candidate',classification:'tradeoff'}:{})});
  assert.throws(()=>inv.submit({summary:'A decision is required here.'}),/needs a proposal/);
  inv.submit({summary:'A decision is required here.',memoryOps:{conflict:[{clientId:'choice',statement:'State ownership requires an explicit decision.',domains:['architecture'],scope:{global:true,paths:[],symbols:[],concepts:[]},targets:[],reason:'Two plausible owners remain.',checkIds:[first],evidenceRefs:[ref]}]},adrs:[{title:'Choose state owner',context:'Two plausible owners remain.',options:['Database','External service'],checkIds:[first],conflictRefs:['choice']}]});
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
test('session coverage bundles replace per-message rereads; atomics reopen for provenance',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await captureSession(f.root,'s1',[{type:'message',id:'new',timestamp:'2026',message:{role:'user',content:'This is an explicit repository constraint.'}}]);
  const snapshot=await collect(f.root,f.config,f.catalog);const inv=new Investigation(route(snapshot,state,f.catalog,f.config,{domain:'agent_policy'})[0],snapshot,f.config);
  assert.ok(inv.evidence.has('bundle:sessions'));
  assert.deepEqual(inv.job.sessionEvidenceIds,['session:s1:new']);
  const refs=[];
  for(const {id} of inv.list().evidence) if(!id.startsWith('bundle:')&&!id.startsWith('session:')) refs.push(readAll(inv,id));
  for(const id of inv.checks.keys()) inv.resolve(outcome(id,refs));
  assert.throws(()=>inv.submit({summary:'These inputs do not change durable knowledge.'}),/bundle:sessions/);
  for(const {id} of inv.list().evidence) if(id.startsWith('bundle:')) readAll(inv,id);
  inv.submit({summary:'These inputs do not change durable knowledge.',memoryOps:{}});
  assert.equal(inv.submission.result,'no_change');
});

test('oversized session bundles fall back to per-entry session reads',async t=>{
  const f=await fixture(t);const {state}=await baseline(f);
  await captureSession(f.root,'s1',[{type:'message',id:'new',timestamp:'2026',message:{role:'user',content:'This is an explicit repository constraint.'}}]);
  const config={...f.config,maxCoverageBundleChars:100};
  const snapshot=await collect(f.root,config,f.catalog);const inv=new Investigation(route(snapshot,state,f.catalog,config,{domain:'agent_policy'})[0],snapshot,config);
  assert.equal(inv.coverage.bundles.sessions.status,'unavailable_too_large');
  assert.equal(inv.coverage.bundles.sessions.required,false);
  assert.equal(inv.evidence.has('bundle:sessions'),false);
  let ref;
  for(const {id} of inv.list().evidence) if(!id.startsWith('session:')) ref=readAll(inv,id);
  for(const id of inv.checks.keys()) inv.resolve(outcome(id,[ref]));
  assert.throws(()=>inv.submit({summary:'These inputs do not change durable knowledge.'}),/unread session/);
});

test('complete surveys expose whole-repository code and prose coverage bundles',async t=>{
  const f=await fixture(t,{
    'src/main.ts':'export const answer = 42;\n',
    'package.json':'{"name":"fixture","version":"1.0.0"}\n',
    'notes/design.md':'# Design\n\nThe worker owns retry state.\n'
  });
  const {snapshot,state}=await baseline(f);
  const job=route(snapshot,state,f.catalog,f.config,{force:true,domain:'dependencies'})[0];
  const inv=new Investigation(job,snapshot,f.config);
  assert.equal(job.coverageRequired,true);
  assert.ok(inv.evidence.has('bundle:code'));
  assert.ok(inv.evidence.has('bundle:prose'));
  assert.match(inv.evidence.get('bundle:code'),/src\/main\.ts/);
  assert.match(inv.evidence.get('bundle:prose'),/notes\/design\.md/);
  assert.ok(!('src/main.ts' in job.surface),'fixture verifies coverage extends beyond the dependencies routing surface');
  assert.equal(inv.coverage.bundles.code.status,'available');
  assert.equal(inv.coverage.bundles.prose.status,'available');
});

test('successful complete surveys must fully consume available coverage bundles',async t=>{
  const inv=await ledger(t);
  const refs=[];
  for(const {id} of inv.list().evidence)if(!id.startsWith('bundle:'))refs.push(readAll(inv,id));
  for(const id of inv.checks.keys())inv.resolve(outcome(id,refs));
  const required=[...Object.values(inv.coverage.bundles)].filter(b=>b.required).flatMap(b=>b.parts.map(p=>p.id));
  assert.ok(required.some(id=>id==='bundle:code'||id.startsWith('bundle:code:')));
  assert.ok(required.some(id=>id==='bundle:prose'||id.startsWith('bundle:prose:')));
  assert.ok(required.some(id=>id==='bundle:git'||id.startsWith('bundle:git:')));
  for(const id of required){
    assert.throws(()=>inv.submit({summary:'No canonical changes are required.',memoryOps:{}}),new RegExp(`requires reading ${id} in full`));
    readAll(inv,id);
  }
  inv.submit({summary:'No canonical changes are required.',memoryOps:{}});
  assert.equal(inv.submission.result,'no_change');
});

test('coverage bundle receipts cannot become durable memory provenance',async t=>{
  const inv=await ledger(t);
  const allRefs=[];
  for(const {id} of inv.list().evidence)allRefs.push(readAll(inv,id));
  const bundleRef=[...inv.receipts.values()].find(r=>r.id==='bundle:code').ref;
  const first=[...inv.checks.keys()][0];
  for(const id of inv.checks.keys())inv.resolve({...outcome(id,allRefs),...(id===first?{outcome:'update'}:{})});
  assert.throws(()=>inv.submit({summary:'Attempt bundle-backed durable memory.',memoryOps:{create:[{kind:'invariant',domains:['architecture'],statement:'Repository code was inspected through a coverage bundle.',scope:{global:true,paths:[],symbols:[],concepts:[]},checkIds:[first],evidenceRefs:[bundleRef]}]}}),/Coverage bundle receipts cannot support durable memory/);
});

test('oversized coverage bundles are explicit and do not pretend to be complete',async t=>{
  const f=await fixture(t);const {snapshot,state}=await baseline(f);
  const config={...f.config,maxCoverageBundleChars:100};
  const job=route(snapshot,state,f.catalog,config,{force:true,domain:'architecture'})[0];
  const inv=new Investigation(job,snapshot,config);
  assert.equal(inv.coverage.bundles.code.status,'unavailable_too_large');
  assert.equal(inv.evidence.has('bundle:code'),false);
  assert.equal(inv.coverage.bundles.code.required,false);
  assert.ok(inv.coverage.bundles.code.chars>config.maxCoverageBundleChars);
});

test('incremental investigations do not add coverage bundle payloads',async t=>{
  const f=await fixture(t);const {snapshot,state}=await baseline(f);
  await put(f.root,'package.json','{"name":"fixture","version":"1.0.1"}\n');
  const next=await collect(f.root,f.config,f.catalog);
  const job=route(next,state,f.catalog,f.config,{domain:'dependencies'})[0];
  const inv=new Investigation(job,next,f.config);
  assert.equal(job.coverageRequired,false);
  assert.equal(inv.coverage.bundles.code.status,'not_required');
  assert.equal(inv.evidence.has('bundle:code'),false);
  assert.equal(inv.evidence.has('bundle:prose'),false);
});
