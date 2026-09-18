import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture,put,complete,readAll,baseline } from './helpers.mjs';
import { setup,migrate,run,inspect,context,memoryHistory } from '../src/engine.mjs';
import { loadState,recover } from '../src/store.mjs';
import { MEMORY_PATH,emptyLedger } from '../src/memory.mjs';
import { STATE_PATH } from '../src/config.mjs';
import { hash,readJson,writeJson } from '../src/util.mjs';
import { parseCommand,tokenize } from '../src/commands.mjs';
import extension from '../extension.ts';

const globalScope={global:true,paths:[],symbols:[],concepts:[]};
const scoped=path=>({global:false,paths:[path],symbols:[],concepts:[]});
const bytes=(root,path)=>readFile(join(root,path),'utf8');
function submit(inv,build,{outcome='update',classification='observed',evidence='file:package.json'}={}) {
  const refs=inv.list().evidence.map(({id})=>readAll(inv,id));
  const checks=[...inv.checks.values()];
  checks.forEach((c,i)=>inv.resolve({id:c.id,outcome:i===0?outcome:'no_finding',finding:'Inspected evidence supports the explicit fixture lifecycle operation.',classification:i===0?classification:'observed',confidence:'high',evidenceRefs:refs}));
  const ref=[...inv.receipts.values()].find(r=>r.id===evidence)?.ref;
  assert.ok(ref,`Fixture evidence exists: ${evidence}`);
  inv.submit({summary:'Completed scoped memory lifecycle investigation.',memoryOps:build({checkIds:[checks[0].id],evidenceRefs:[ref]})});
}

test('legacy migration preserves exact originals, imports separate bullets as unverified, and is idempotent',async t=>{
  const f=await fixture(t);await rm(join(f.root,MEMORY_PATH));
  const path='.agents/engineering/ARCHITECTURE.md';
  const original='# Architecture\r\n\r\n- Redis is temporary.\r\n- PostgreSQL owns durable state.\r\n';
  await put(f.root,path,original);
  assert.equal((await setup(f.root)).migrationRequired,true);assert.equal(await bytes(f.root,path),original);
  await assert.rejects(()=>run(f.root,{curator:complete}),/migration required/);
  const result=await migrate(f.root);assert.equal(result.imported.length,2);assert.equal(await bytes(f.root,result.backups[0]),original);
  const ledger=await readJson(f.root,MEMORY_PATH);assert.ok(ledger.records.every(r=>r.status==='unverified'&&r.migration.scopeNeedsReview));
  assert.equal((await context(f.root,{paths:['src/main.ts']})).conventions.length,0);
  const before=await bytes(f.root,MEMORY_PATH),state=await bytes(f.root,STATE_PATH);
  assert.equal((await migrate(f.root)).imported.length,0);assert.equal(await bytes(f.root,MEMORY_PATH),before);assert.equal(await bytes(f.root,STATE_PATH),state);
  const view=await inspect(f.root);assert.equal(view.snapshot.contents.get(`archive:${result.backups[0]}`),original);
});
test('same legacy wording in different domains retains both applicability candidates',async t=>{
  const f=await fixture(t);await rm(join(f.root,MEMORY_PATH));
  for(const name of ['ARCHITECTURE','TESTING'])await put(f.root,`.agents/engineering/${name}.md`,'# Legacy\n\n- Retry processing must be idempotent.\n');
  await migrate(f.root);const ledger=await readJson(f.root,MEMORY_PATH);
  assert.deepEqual(ledger.records.map(r=>r.domains[0]).sort(),['architecture','testing']);
});
test('manual view edits block curation until migration and do not reimport unchanged generated entries',async t=>{
  const f=await fixture(t);await run(f.root,{domain:'dependencies',curator:complete});
  const path='.agents/engineering/DEPENDENCIES.md',before=await bytes(f.root,path);
  await put(f.root,path,before+'\n- New human claim requiring evidence review.\n');
  await assert.rejects(()=>run(f.root,{domain:'dependencies',curator:complete}),/manual edits/);
  await assert.rejects(()=>context(f.root),/views were edited/);
  const result=await migrate(f.root);assert.equal(result.imported.length,1);
  const ledger=await readJson(f.root,MEMORY_PATH);assert.equal(ledger.records.length,2);
  assert.equal(ledger.records[1].statement,'New human claim requiring evidence review.');
});
test('imported claims require archive, atomicity, scope, and current evidence before activation',async t=>{
  const f=await fixture(t);await put(f.root,'.agents/engineering/DEPENDENCIES.md','# Dependencies\n\n- Package metadata is declared in package.json.\n');
  await migrate(f.root);const target=(await readJson(f.root,MEMORY_PATH)).records[0].id;
  let result=await run(f.root,{domain:'dependencies',curator:inv=>submit(inv,refs=>({reinforce:[{...refs,target,reason:'Current manifest confirms this claim.'}]}))});
  assert.equal(result.results[0].result,'failed');assert.match(result.results[0].error,/atomicity and scope/);
  result=await run(f.root,{domain:'dependencies',curator:inv=>submit(inv,refs=>({reinforce:[{...refs,target,reason:'Current manifest confirms this claim.',atomicityReviewed:true,reviewedScope:scoped('package.json')}]}))});
  assert.equal(result.results[0].result,'updated');const history=await memoryHistory(f.root,target);
  assert.equal(history.record.status,'active');assert.equal(history.record.migration.scopeNeedsReview,false);assert.equal(history.events.length,2);
});
test('conflicts persist and retry without duplicates while source and session freshness remain unchanged',async t=>{
  const f=await fixture(t);await run(f.root,{domain:'dependencies',curator:complete});
  const initial=(await loadState(f.root)).documents.dependencies;
  const target=(await readJson(f.root,MEMORY_PATH)).records[0].id;
  const curator=inv=>submit(inv,refs=>({conflict:[{...refs,statement:'Package evidence disagrees with the stored dependency claim.',domains:['dependencies'],scope:globalScope,targets:[target],reason:'The fixture evidence exposes an unresolved contradiction.'}]}),{outcome:'conflict',classification:'violation'});
  for(let n=0;n<2;n++)assert.equal((await run(f.root,{domain:'dependencies',force:true,curator})).results[0].result,'blocked');
  const ledger=await readJson(f.root,MEMORY_PATH);assert.equal(ledger.records.length,2);assert.equal(ledger.records[0].status,'conflicted');
  const state=(await loadState(f.root)).documents.dependencies;
  for(const key of ['inputFingerprint','memoryFingerprint','lastCuratedAt','sessions'])assert.deepEqual(state[key],initial[key]);
  const view=await inspect(f.root,{domain:'dependencies'});assert.equal(view.jobs[0].conflicts.length,1);assert.equal(view.jobs[0].routing,'inspect');
  const applicable=await context(f.root);assert.equal(applicable.conflicts.length,1);assert.equal(applicable.invariants.length,0);
  const conflict=ledger.records[1].id;
  const resolved=await run(f.root,{domain:'dependencies',curator:inv=>submit(inv,refs=>({resolve:[{...refs,target:conflict,resolution:'keep',reason:'Current evidence validates the original observed claim.'}]}))});
  assert.equal(resolved.results[0].result,'updated');assert.equal((await inspect(f.root,{domain:'dependencies'})).jobs[0].status,'unchanged');
});
test('open questions require a genuinely accepted ADR, then explicit resolution closes them',async t=>{
  const f=await fixture(t);
  await run(f.root,{domain:'architecture',curator:inv=>submit(inv,refs=>({conflict:[{...refs,statement:'Which datastore should own settlement?',domains:['architecture'],scope:globalScope,targets:[],reason:'A product decision is missing.'}]}),{outcome:'conflict',classification:'open_question'})});
  const target=(await readJson(f.root,MEMORY_PATH)).records[0].id;
  const decision='docs/adr/settlement.md';
  await put(f.root,decision,'# Settlement\n\nStatus: Proposed\n\nThe word Accepted in prose does not accept this ADR.\n');
  const curator=inv=>submit(inv,refs=>({resolve:[{...refs,target,resolution:'keep',reason:'The explicit accepted decision settles ownership.'}]}),{classification:'decision',evidence:`file:${decision}`});
  let result=await run(f.root,{domain:'architecture',curator});assert.equal(result.results[0].result,'failed');assert.match(result.results[0].error,/authoritative evidence/);
  await put(f.root,decision,'---\nstatus: accepted\n---\n# Settlement\n\nPostgreSQL owns settlement.\n');
  result=await run(f.root,{domain:'architecture',curator});assert.equal(result.results[0].result,'updated');
  assert.equal((await memoryHistory(f.root,target)).record.status,'resolved');
});
test('shared memory updates every view without certifying sibling source baselines',async t=>{
  const f=await fixture(t),{state}=await baseline(f);await writeJson(f.root,STATE_PATH,state);
  const before=(await loadState(f.root)).documents.security;
  const result=await run(f.root,{domain:'architecture',force:true,curator:inv=>submit(inv,refs=>({create:[{...refs,kind:'invariant',statement:'Package metadata declares the repository identity.',domains:['architecture','security'],scope:globalScope}]}))});
  assert.equal(result.results[0].result,'updated');
  for(const name of ['ARCHITECTURE','SECURITY'])assert.match(await bytes(f.root,`.agents/engineering/${name}.md`),/Package metadata declares/);
  const after=(await loadState(f.root)).documents.security;
  assert.equal(after.inputFingerprint,before.inputFingerprint);assert.equal(after.memoryFingerprint,before.memoryFingerprint);
  assert.equal((await inspect(f.root,{domain:'security'})).jobs[0].status,'affected');
});
test('memory scope adds otherwise unrelated source files to deterministic routing',async t=>{
  const f=await fixture(t);await put(f.root,'custom/policy.xml','<policy>one</policy>');
  await run(f.root,{domain:'dependencies',curator:inv=>submit(inv,refs=>({create:[{...refs,kind:'invariant',statement:'Custom policy influences dependency selection.',domains:['dependencies'],scope:scoped('custom/*.xml')}]}))});
  assert.equal((await inspect(f.root,{domain:'dependencies'})).jobs[0].status,'unchanged');
  await put(f.root,'custom/policy.xml','<policy>two</policy>');
  const job=(await inspect(f.root,{domain:'dependencies'})).jobs[0];assert.equal(job.routing,'inspect');assert.ok(job.changedFiles.includes('custom/policy.xml'));
});
test('scar removal signals route review and never retire a memory automatically',async t=>{
  const f=await fixture(t);await put(f.root,'legacy/client.xml','compatibility client');
  await run(f.root,{domain:'maintainability',curator:inv=>submit(inv,refs=>({scarCandidates:[{...refs,statement:'Legacy client compatibility remains necessary.',domains:['maintainability'],scope:scoped('legacy/**'),reason:'Older clients depend on this surface.',constraint:'Keep the compatibility interface.',removalCondition:'Verify removal of the final legacy client.',removalSignals:[{type:'paths_absent',path:'legacy/**'}]}]}))});
  await rm(join(f.root,'legacy/client.xml'));
  const job=(await inspect(f.root,{domain:'maintainability'})).jobs[0];assert.ok(job.triggers.some(t=>t.id==='scar-removal-review'));assert.equal(job.removalCandidates.length,1);
  assert.equal((await readJson(f.root,MEMORY_PATH)).records[0].status,'active');
});
test('newly scoped but unread source remains pending for another investigation',async t=>{
  const f=await fixture(t);await put(f.root,'custom/policy.xml','<policy>unread</policy>');
  const result=await run(f.root,{domain:'dependencies',curator:inv=>{
    const refs=inv.list().evidence.filter(e=>e.id!=='file:custom/policy.xml').map(({id})=>readAll(inv,id));
    const checks=[...inv.checks.values()];
    checks.forEach((c,i)=>inv.resolve({id:c.id,outcome:i===0?'update':'no_finding',finding:'The package evidence supports the new scoped claim.',classification:'observed',confidence:'high',evidenceRefs:refs}));
    const ref=[...inv.receipts.values()].find(r=>r.id==='file:package.json').ref;
    inv.submit({summary:'Record a supported scoped claim; additional scope needs review.',memoryOps:{create:[{kind:'invariant',statement:'Dependency review includes the custom policy file.',domains:['dependencies'],scope:scoped('custom/*.xml'),checkIds:[checks[0].id],evidenceRefs:[ref]}]}});
  }});
  assert.equal(result.results[0].result,'updated');
  let job=(await inspect(f.root,{domain:'dependencies'})).jobs[0];assert.equal(job.routing,'inspect');assert.ok(job.changedFiles.includes('custom/policy.xml'));
  await run(f.root,{domain:'dependencies',curator:complete});job=(await inspect(f.root,{domain:'dependencies'})).jobs[0];assert.equal(job.status,'unchanged');
});
test('ledger, configuration, and registry edits during investigation invalidate proposals',async t=>{
  for(const path of [MEMORY_PATH,'.agents/curation/config.json','.agents/curation/registry.json']) {
    const f=await fixture(t);let external;
    const result=await run(f.root,{domain:'dependencies',curator:async inv=>{
      complete(inv);external=await readJson(f.root,path);
      if(path===MEMORY_PATH)external.revision++;
      else if(path.endsWith('config.json'))external.maxTurns++;
      else external.documents[0].version++;
      await writeJson(f.root,path,external);
    }});
    assert.equal(result.results[0].result,'failed');assert.deepEqual(await readJson(f.root,path),external);assert.equal((await loadState(f.root)).documents.dependencies,undefined);
  }
});
test('external state edits are preserved instead of overwritten by failure bookkeeping',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>run(f.root,{domain:'dependencies',curator:async inv=>{complete(inv);const state=await loadState(f.root);state.tick=999;await writeJson(f.root,STATE_PATH,state);}}),/externally changed/);
  assert.equal((await loadState(f.root)).tick,999);
});
test('multi-file recovery completes partial writes and readers refuse pending transactions',async t=>{
  const f=await fixture(t),old=await bytes(f.root,MEMORY_PATH),ledger={...emptyLedger(),revision:3};
  const state={version:1,documents:{},queue:{},tick:7};
  const entries=[{path:MEMORY_PATH,expectedHash:hash(old),nextContent:JSON.stringify(ledger,null,2)+'\n'},{path:'.agents/engineering/ARCHITECTURE.md',expectedHash:null,nextContent:'# Recovered view\n'},{path:STATE_PATH,expectedHash:null,nextContent:JSON.stringify(state,null,2)+'\n'}];
  await writeJson(f.root,'.agents/curation/transaction.json',{version:2,entries,reportPath:'test'});await put(f.root,MEMORY_PATH,entries[0].nextContent);
  await assert.rejects(()=>inspect(f.root),/Incomplete transaction/);await recover(f.root);await recover(f.root);
  assert.equal((await loadState(f.root)).tick,7);assert.equal(await bytes(f.root,entries[1].path),entries[1].nextContent);assert.equal(await readJson(f.root,'.agents/curation/transaction.json'),null);
});
test('recovery preflights every target before writing any pending entry',async t=>{
  const f=await fixture(t),old=await bytes(f.root,MEMORY_PATH),path='.agents/engineering/ARCHITECTURE.md';
  await put(f.root,path,'Human edit after interruption');
  await writeJson(f.root,'.agents/curation/transaction.json',{version:2,reportPath:'test',entries:[{path:MEMORY_PATH,expectedHash:hash(old),nextContent:JSON.stringify({...emptyLedger(),revision:9})},{path,expectedHash:null,nextContent:'# Proposed view'}]});
  await assert.rejects(()=>recover(f.root),/external edit/);assert.equal(await bytes(f.root,MEMORY_PATH),old);assert.equal(await bytes(f.root,path),'Human edit after interruption');
});
test('context command parsing preserves quoted selectors without shell interpretation',()=>{
  const parsed=parseCommand(tokenize('context --paths "src/with space.ts" src/other.ts --symbols Handler --concepts "payment settlement" --max-chars 4000'));
  assert.deepEqual(parsed.query,{paths:['src/with space.ts','src/other.ts'],symbols:['Handler'],concepts:['payment settlement'],maxChars:4000});
  assert.throws(()=>parseCommand(['context','src/main.ts']),/uses --paths/);
});
test('opt-in context injection handles natural apostrophes and falls back when paths are unknown',async t=>{
  const f=await fixture(t);await run(f.root,{domain:'dependencies',curator:complete});
  const config=await readJson(f.root,'.agents/curation/config.json');await writeJson(f.root,'.agents/curation/config.json',{...config,contextInjection:true});
  const handlers={};extension({registerCommand(){},on:(event,fn)=>handlers[event]=fn});
  const ctx={cwd:f.root};
  const injected=await handlers.before_agent_start({prompt:"Don't change `src/main.ts`; explain it.",systemPrompt:'Base'},ctx);
  assert.match(injected.systemPrompt,/Applicable engineering memory/);assert.match(injected.systemPrompt,/Inspection is pending/);
  const fallback=await handlers.before_agent_start({prompt:'Explain this repository.',systemPrompt:'Base'},ctx);assert.match(fallback.systemPrompt,/Engineering memory lives/);
});
