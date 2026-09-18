import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger,reconcile,deriveConfidence,validateLedger,memoryFingerprint,resolveApplicable,scarSignals } from '../src/memory.mjs';
import { renderViews } from '../src/views.mjs';
import { hash } from '../src/util.mjs';

const now='2026-09-18T00:00:00.000Z';
const globalScope={global:true,paths:[],symbols:[],concepts:[]};
export const sourceEvidence=[{type:'source',ref:'file:src/billing.ts',hash:hash('evidence'),start:0,end:8,classification:'observed',reportPath:'test-report',at:now}];
const authoritative=[{...sourceEvidence[0],type:'session',ref:'session:s:u1',role:'user',classification:'decision'}];
export const claim=(overrides={})=>({kind:'invariant',domains:['architecture'],statement:'The billing service owns entitlement state.',scope:globalScope,...overrides});
export const apply=(ledger,ops,provenance=sourceEvidence,extra={})=>reconcile(ledger,ops,{domain:'architecture',provenanceFor:()=>provenance,reportPath:'test-report',now,...extra}).ledger;
const create=(record=claim(),provenance=sourceEvidence)=>apply(emptyLedger(),{create:[record]},provenance);

test('ledger creation derives authority from source type and user role',()=>{
  assert.equal(deriveConfidence(authoritative),'authoritative');
  assert.equal(deriveConfidence([{...authoritative[0],role:'assistant'}]),'inferred');
  assert.equal(deriveConfidence(sourceEvidence),'strong');
  assert.equal(deriveConfidence([{...sourceEvidence[0],type:'doc'}]),'inferred');
  assert.equal(create().records[0].basis,'observed');
  const policy=create(claim({kind:'constraint'}));assert.equal(policy.records[0].status,'unverified');
  assert.equal(create(claim({kind:'constraint'}),authoritative).records[0].status,'active');
});
test('an unaccepted ADR or multiple assistant messages cannot supply authority',()=>{
  assert.equal(deriveConfidence([{...authoritative[0],type:'decision',accepted:false}]),'inferred');
  assert.equal(deriveConfidence([{...authoritative[0],type:'decision',accepted:true}]),'authoritative');
  assert.equal(deriveConfidence([1,2].map(n=>({...authoritative[0],ref:`session:s:${n}`,role:'assistant'}))),'inferred');
});
test('different Git layers of one file are not independent confidence sources',()=>{
  const layers=['file','index','head'].map(layer=>({...sourceEvidence[0],ref:`${layer}:src/billing.ts`,classification:'inferred'}));
  assert.equal(deriveConfidence(layers),'inferred');
  assert.equal(deriveConfidence([...layers,{...layers[0],ref:'file:src/independent.ts'}]),'supported');
});
test('atomicity validation rejects multiline structure, not valid uses of and',()=>{
  assert.throws(()=>create(claim({statement:'One claim.\nAnother claim.'})),/one paragraph/);
  assert.equal(create(claim({statement:'Requests use an all-or-nothing read and write transaction.'})).records.length,1);
});
test('scope rejects traversal and ambiguous empty selectors',()=>{
  assert.throws(()=>create(claim({scope:{global:false,paths:[],symbols:[],concepts:[]}})),/explicit selectors/);
  assert.throws(()=>create(claim({scope:{global:false,paths:['../outside/**'],symbols:[],concepts:[]}})),/Unsafe/);
});
test('exact identical claims merge across domains; near matches and scopes stay separate',()=>{
  let ledger=create();const original=ledger.records[0].id;
  ledger=apply(ledger,{create:[claim({domains:['security'],statement:'The billing service owns entitlement state.'})]},sourceEvidence,{domain:'security'});
  assert.equal(ledger.records.length,1);assert.equal(ledger.records[0].id,original);assert.deepEqual(ledger.records[0].domains,['architecture','security']);
  ledger=apply(ledger,{create:[claim({statement:'The billing service does not own entitlement state.'}),claim({scope:{global:false,paths:['src/legacy/**'],symbols:[],concepts:[]}})]});
  assert.equal(ledger.records.length,3);
});
test('reinforcement retains history without creating semantic freshness loops',()=>{
  const original=create(),fingerprint=memoryFingerprint(original,'architecture');
  const ledger=apply(original,{reinforce:[{target:original.records[0].id,reason:'Current implementation still supports this fact.'}]},sourceEvidence,{now:'2026-09-19T00:00:00.000Z'});
  assert.equal(memoryFingerprint(ledger,'architecture'),fingerprint);assert.equal(ledger.events.length,2);assert.equal(ledger.records[0].provenance.length,1);assert.equal(original.events.length,1);
});
test('supersede creates a linked replacement and preserves a tombstone',()=>{
  const original=create();const target=original.records[0].id;
  const ledger=apply(original,{supersede:[{target,reason:'State ownership moved with the supported migration.',replacement:claim({statement:'The entitlement service owns entitlement state.'})}]});
  assert.equal(ledger.records[0].status,'superseded');assert.deepEqual(ledger.records[1].supersedes,[target]);assert.equal(ledger.records[1].status,'active');
  assert.equal(resolveApplicable(ledger).invariants.length,1);assert.equal(ledger.events.length,3);
});
test('code cannot supersede or retire an explicit user constraint',()=>{
  const original=create(claim({kind:'constraint'}),authoritative);const target=original.records[0].id;
  assert.throws(()=>apply(original,{invalidate:[{target,status:'obsolete',reason:'The code no longer follows this policy.'}]}),/authoritative evidence/);
  assert.throws(()=>apply(original,{supersede:[{target,reason:'Implementation differs.',replacement:claim({statement:'Redis is authoritative.'})}]}),/authoritative evidence/);
  const retired=apply(original,{invalidate:[{target,status:'obsolete',reason:'The user explicitly retired this policy.'}]},authoritative);assert.equal(retired.records[0].status,'obsolete');
});
test('invalid batches never mutate the input ledger',()=>{
  const original=create(),before=JSON.stringify(original);
  assert.throws(()=>apply(original,{create:[claim({statement:'A second valid fact.'})],invalidate:[{target:'mem_unknown',status:'obsolete',reason:'Wrong target'}]}),/Unknown memory/);
  assert.equal(JSON.stringify(original),before);
});
test('conflicts suppress contested claims, deduplicate on retry, and resolve explicitly',()=>{
  const original=create();const target=original.records[0].id;
  const conflict={statement:'The implementation disagrees about entitlement ownership.',targets:[target],domains:['architecture'],scope:globalScope,reason:'Two sources disagree.'};
  let ledger=apply(original,{conflict:[conflict]},sourceEvidence,{blocked:true});
  assert.equal(ledger.records[0].status,'conflicted');assert.equal(resolveApplicable(ledger).invariants.length,0);assert.equal(resolveApplicable(ledger).conflicts.length,1);
  ledger=apply(ledger,{conflict:[conflict]},sourceEvidence,{blocked:true});assert.equal(ledger.records.length,2);
  const conflictId=ledger.records[1].id;
  ledger=apply(ledger,{resolve:[{target:conflictId,resolution:'keep',reason:'The current implementation confirms the original claim.'}]});
  assert.equal(ledger.records[0].status,'active');assert.equal(ledger.records[1].status,'resolved');assert.equal(resolveApplicable(ledger).invariants.length,1);
});
test('blocked attempts may record conflicts but cannot create active policy',()=>{
  assert.throws(()=>apply(emptyLedger(),{create:[claim()]},sourceEvidence,{blocked:true}),/only record conflicts/);
});
test('a conflict remains retrievable throughout its target scope',()=>{
  const original=create(),target=original.records[0].id;
  const ledger=apply(original,{conflict:[{statement:'Local evidence disputes the global claim.',targets:[target],domains:['architecture'],scope:{global:false,paths:['src/legacy/**'],symbols:[],concepts:[]},reason:'Contradiction needs repository-wide visibility.'}]});
  assert.equal(resolveApplicable(ledger,{paths:['src/unrelated.ts']}).conflicts.length,1);
  assert.equal(resolveApplicable(ledger,{paths:['src/unrelated.ts']}).invariants.length,0);
});
test('scar signals only request review and retirement keeps audit history',()=>{
  let ledger=create(claim({kind:'scar',statement:'Legacy token decoding remains for compatibility.',reason:'Older clients still depend on it.',constraint:'Do not add new authentication behavior here.',removalCondition:'Retire when the legacy path is removed and compatibility is verified.',removalSignals:[{type:'paths_absent',path:'src/legacy/**'}]}));
  assert.equal(scarSignals(ledger,{'src/legacy/tokens.ts':{}})[0].satisfied,false);
  assert.equal(scarSignals(ledger,{})[0].satisfied,true);assert.equal(ledger.records[0].status,'active');
  ledger=apply(ledger,{invalidate:[{target:ledger.records[0].id,status:'resolved',reason:'Removal conditions were investigated and verified.'}]});
  assert.equal(ledger.records[0].scarState,'resolved');assert.equal(resolveApplicable(ledger).scars.length,0);assert.equal(ledger.events.length,2);
});
test('context matches explicit paths, exact symbols, exact concepts, and globals',()=>{
  const ledger=apply(create(),{create:[claim({statement:'Legacy billing uses a compatibility adapter.',scope:{global:false,paths:['src/legacy/**'],symbols:['BillingAdapter'],concepts:['billing']}})]});
  assert.equal(resolveApplicable(ledger,{paths:['src/legacy/api.ts']}).invariants.length,2);
  assert.equal(resolveApplicable(ledger,{symbols:['BillingAdapter']}).invariants.length,2);
  assert.equal(resolveApplicable(ledger,{symbols:['Billing']}).invariants.length,1);
  assert.equal(resolveApplicable(ledger,{concepts:['BILLING']}).invariants.length,2);
  assert.equal(resolveApplicable(ledger,{concepts:['bill']}).invariants.length,1);
  assert.equal(resolveApplicable(ledger).invariants.length,1);
});
test('retrieval budgets explicitly report omissions instead of silent truncation',()=>{
  const result=resolveApplicable(create(),{maxChars:1});assert.equal(result.truncated,true);assert.equal(result.omittedIds.length,1);assert.equal(result.matched,1);
});
test('multi-domain views are deterministic and lifecycle-aware',()=>{
  let ledger=create(claim({domains:['architecture','testing']}));
  const catalog={documents:['architecture','testing'].map(id=>({id,path:`.agents/engineering/${id.toUpperCase()}.md`}))};
  const first=renderViews(ledger,catalog);assert.match(first['.agents/engineering/ARCHITECTURE.md'],/owns entitlement/);assert.match(first['.agents/engineering/TESTING.md'],/owns entitlement/);
  assert.deepEqual(renderViews(ledger,catalog),first);
  ledger=apply(ledger,{invalidate:[{target:ledger.records[0].id,status:'obsolete',reason:'This fact no longer applies.'}]});assert.doesNotMatch(renderViews(ledger,catalog)['.agents/engineering/ARCHITECTURE.md'],/owns entitlement/);
});
test('unverified claims are labeled in views and excluded from normative retrieval',()=>{
  const ledger=create(claim(),[{...sourceEvidence[0],type:'doc'}]);
  const views=renderViews(ledger,{documents:[{id:'architecture',path:'ARCHITECTURE.md'}]});
  assert.match(views['ARCHITECTURE.md'],/Unverified imports/);assert.equal(resolveApplicable(ledger).invariants.length,0);
});
test('ledger validates links, projection ownership, cycles, and capacity',()=>{
  const ledger=create();const corrupt=structuredClone(ledger);corrupt.records[0].supersedes=['mem_'+'0'.repeat(32)];assert.throws(()=>validateLedger(corrupt),/known record/);
  const wrong=structuredClone(ledger);wrong.records[0].exposeTo=['SECURITY.md'];assert.throws(()=>validateLedger(wrong),/Projection/);
  assert.throws(()=>validateLedger(ledger,{maxRecords:0}),/record limit/);
  assert.throws(()=>validateLedger(ledger,{maxLedgerBytes:10}),/byte limit/);
});
