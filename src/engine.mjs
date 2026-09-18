import { randomUUID } from 'node:crypto';
import { loadConfig, loadRegistry, initialize, CONFIG_PATH, STATE_PATH } from './config.mjs';
import { collect, repositoryRoot, captureSession } from './collector.mjs';
import { route, schedule, publicJob } from './router.mjs';
import { Investigation } from './investigation.mjs';
import { loadState, withLock, commitBatch } from './store.mjs';
import { emptyLedger, MEMORY_PATH, memoryFingerprint, resolveApplicable, openConflicts, validateLedger } from './memory.mjs';
import { renderViews, projectionHashes, renderAgents, hindsightIndex } from './views.mjs';
import { importDocuments } from './migration.mjs';
export { hindsightIndex } from './views.mjs';
export { knowledgeIndex } from './views.mjs';
import { assert, hash, optionalRead, safePath, atomicWrite, writeJson } from './util.mjs';

export async function inspect(cwd, options = {}) {
  const root = await repositoryRoot(cwd);
  assert(await optionalRead(await safePath(root,'.agents/curation/transaction.json'))===null,'Incomplete transaction: run a write command to recover before reading memory');
  const {config,initialized} = await loadConfig(root);
  const {catalog} = await loadRegistry(root);
  if (options.domain) assert(catalog.documents.some(d => d.id === options.domain), `Unknown domain: ${options.domain}`);
  const state = await loadState(root);
  const snapshot = await collect(root,config,catalog);
  const jobs = route(snapshot,state,catalog,config,options);
  const viewDrift=catalog.documents.filter(d=>snapshot.documents[d.id].content!==null&&snapshot.ledger?.projections[d.id]!==snapshot.documents[d.id].hash).map(d=>d.id);
  assert(await optionalRead(await safePath(root,'.agents/curation/transaction.json'))===null,'Incomplete transaction: retry after recovery before reading memory');
  return {root,config,initialized,catalog,state,snapshot,jobs,viewDrift,migrationRequired:!snapshot.ledger&&viewDrift.length>0};
}

export async function setup(cwd) {
  const root = await repositoryRoot(cwd);
  return withLock(root,async () => {
    await initialize(root);
    const {catalog} = await loadRegistry(root);
    const snapshot=await collect(root,(await loadConfig(root)).config,catalog);
    const existing=catalog.documents.some(d=>snapshot.documents[d.id].content!==null);
    const target=await safePath(root,'AGENTS.md');
    const current=await optionalRead(target),next=renderAgents(current,catalog);
    const entries=[];
    if(!snapshot.ledger&&!existing)entries.push({path:MEMORY_PATH,previousContent:null,nextContent:JSON.stringify(emptyLedger(),null,2)+'\n'});
    if(current!==next)entries.push({path:'AGENTS.md',previousContent:current,nextContent:next});
    if(entries.length)await commitBatch(root,entries,'initialization');
    return {root,auto:(await loadConfig(root)).config.auto,migrationRequired:!snapshot.ledger&&existing,message:!snapshot.ledger&&existing?'Existing engineering documents detected. Run /hindsight migrate to archive originals and import unverified memory candidates.':'Initialized memory ledger. Manual mode: /hindsight scan routes work; /hindsight run investigates; /hindsight auto scan or /hindsight auto run enables automatic curation.'};
  });
}
export async function setAuto(cwd, mode) {
  assert(['off','scan','run'].includes(mode),'Choose auto off, scan, or run');
  const root = await repositoryRoot(cwd);
  return withLock(root,async () => {
    const {config,initialized} = await loadConfig(root);
    assert(initialized,'Run /hindsight init first');
    await writeJson(root,CONFIG_PATH,{...config,auto:mode});
    return mode;
  });
}
export async function capture(cwd, sessionId, entries) {
  const root = await repositoryRoot(cwd);
  const {initialized} = await loadConfig(root);
  if (!initialized) return;
  return withLock(root,() => captureSession(root,sessionId,entries));
}

export async function run(cwd, options = {}) {
  const root = await repositoryRoot(cwd);
  const initial = await loadConfig(root);
  assert(initial.initialized,'Run /hindsight init first');
  return withLock(root,async () => {
    const initialView = await inspect(root,options);
    const {config,catalog} = initialView;
    let state = initialView.state;
    const initialStateHash=hash(state);
    if(!options.scanOnly) {
      assert(initialView.snapshot.ledger,'Memory migration required: run /hindsight migrate before curating existing documents');
      assert(!initialView.viewDrift.length,`Generated views contain manual edits: ${initialView.viewDrift.join(', ')}. Use /hindsight migrate to preserve and import them before regeneration`);
    }
    const selected = schedule(initialView.jobs,state,config,{manual:options.manual !== false,event:options.event === true});
    assert(hash(await loadState(root))===initialStateHash,'Curation state changed during scheduling');
    await writeJson(root,STATE_PATH,state);
    if (options.scanOnly) return {jobs:initialView.jobs.map(publicJob),results:[],pending:Object.keys(state.queue),eligible:selected.map(j => j.domain)};
    const invoke = options.curator ?? (async (...args) => (await import('./pi-sdk.mjs')).runPiCurator(...args));
    const results = [];
    for (const scheduled of selected) {
      if (options.signal?.aborted) break;
      // Prior curators may have changed canonical knowledge. Rebuild cross-document evidence for each job.
      const snapshot = await collect(root,config,catalog);
      snapshot.expectedStateHash=hash(state);
      const job = route(snapshot,state,catalog,config,{...options,domain:scheduled.domain})[0];
      if (job.routing === 'skip') continue;
      const investigation = new Investigation(job,snapshot,config);
      const id = `${Date.now()}-${randomUUID()}`;
      const reportPath = `.agents/curation/${job.domain}/runs/${id}.json`;
      investigation.reportPath=reportPath;
      options.onProgress?.({domain:job.domain,status:'investigating',checks:job.checks.length});
      let metrics = null;
      try {
        assert(!job.sessionBlocked,'A session episode exceeds maxSessionBatchChars; raise the limit before acknowledging it');
        metrics = await invoke(investigation,options);
        assert(investigation.submission,'Curator did not submit an investigation');
        assert(hash((await loadConfig(root)).config)===hash(config)&&hash((await loadRegistry(root)).catalog)===hash(catalog),'Configuration or registry changed during investigation');
        assert(hash(await loadState(root))===snapshot.expectedStateHash,'Curation state changed during investigation');
        const report = {...investigation.report(),metrics,recordedAt:new Date().toISOString()};
        await writeJson(root,reportPath,report);
        await writeJson(root,`.agents/curation/${job.domain}/last-investigation.json`,{reportPath,...report});
        const {submission} = investigation;
        const latest = await collect(root,config,catalog);
        assert(latest.snapshotHash === snapshot.snapshotHash,'Repository or session evidence changed during investigation; retry against the new snapshot');
        assert(latest.ledgerHash===snapshot.ledgerHash,'Memory ledger changed during investigation; retry without overwriting it');
        for (const doc of catalog.documents) assert(latest.documents[doc.id].hash === snapshot.documents[doc.id].hash, `Canonical ${doc.id} changed during investigation; retry without overwriting it`);
        const previous=state.documents[job.domain];
        const nextState=structuredClone(state);
        const nextLedger=investigation.proposedLedger;
        const views=renderViews(nextLedger,catalog,config);
        nextLedger.projections=projectionHashes(views,catalog);
        // Sibling views are regenerated from the same record; their source/memory inspection baselines stay untouched.
        for(const doc of catalog.documents)if(nextState.documents[doc.id])nextState.documents[doc.id].documentFingerprint=nextLedger.projections[doc.id];
        if(submission.result==='blocked') {
          nextState.queue[job.domain]={...state.queue[job.domain],retryAt:state.tick+config.retryDelayEvents,lastResult:'blocked',reportPath};
        } else {
          const expanded=route({...snapshot,ledger:nextLedger},state,catalog,config,{domain:job.domain})[0];
          // New scopes/provenance may expand the domain. Acknowledge that expansion only if inspected.
          const readExpansion=Object.keys(expanded.surface).filter(p=>!(p in job.surface)).every(p=>['file','index','head'].every(layer=>!investigation.evidence.has(`${layer}:${p}`)||investigation.fullyRead(`${layer}:${p}`)));
          const baseline=readExpansion?expanded:job;
          nextState.documents[job.domain]={lastCuratedCommit:snapshot.head,inputFingerprint:baseline.inputFingerprint,documentFingerprint:nextLedger.projections[job.domain],ruleFingerprint:job.ruleFingerprint,files:baseline.surface,sessions:{...(previous?.sessions??{}),...Object.fromEntries(job.sessionEvidenceIds.map(id=>[id,snapshot.sessions.find(s=>s.id===id)?.hash]))},sessionEpisodes:{...(previous?.sessionEpisodes??{}),...Object.fromEntries(job.sessionBatch.map(e=>[e.id,e.hash]))},churnHash:baseline.churnHash,memoryFingerprint:memoryFingerprint(nextLedger,job.domain),scarFingerprint:job.scarFingerprint,lastResult:submission.result,lastInvestigation:reportPath,lastCuratedAt:new Date().toISOString()};
          if(job.pendingSessions>job.sessionBatch.length)nextState.queue[job.domain]={...state.queue[job.domain],retryAt:0,lastResult:'session_batch_complete'};
          else delete nextState.queue[job.domain];
        }
        for(const affected of submission.affectedDomains)if(affected!==job.domain)nextState.queue[affected]??={firstTick:state.tick,signature:'memory-changed'};
        if(submission.result==='blocked'&&!submission.recordChanges.length) {
          // No conflict recorded: keep canonical ledger and views byte-for-byte unchanged.
          assert(hash(await loadState(root))===snapshot.expectedStateHash,'Curation state changed before recording result');
          await writeJson(root,STATE_PATH,nextState);
        } else await persistLedger(root,snapshot,nextLedger,views,nextState,catalog,reportPath);
        state=nextState;
        results.push({domain:job.domain,result:submission.result,reportPath,metrics,recordChanges:submission.recordChanges,conflicts:openConflicts(nextLedger,job.domain).map(r=>r.id)});
      } catch (error) {
        const report = {...investigation.report(),metrics,error:String(error.message ?? error),recordedAt:new Date().toISOString()};
        await writeJson(root,reportPath,report);
        await writeJson(root,`.agents/curation/${job.domain}/last-investigation.json`,{reportPath,...report});
        // A partially applied transaction must be recovered before any subsequent job/state write.
        const journal = await optionalRead(await safePath(root,'.agents/curation/transaction.json'));
        if (journal !== null) throw new Error(`Commit interrupted; recovery is required. ${report.error}`);
        assert(hash(await loadState(root))===snapshot.expectedStateHash,`State was externally changed; stopped without overwriting it. ${report.error}`);
        state.queue[job.domain] = {...state.queue[job.domain],retryAt:state.tick+config.retryDelayEvents,lastResult:'failed',reportPath};
        await writeJson(root,STATE_PATH,state);
        results.push({domain:job.domain,result:'failed',error:report.error,reportPath});
      }
      options.onProgress?.(results.at(-1));
    }
    return {results,jobs:initialView.jobs.map(publicJob),pending:Object.keys(state.queue)};
  });
}

async function persistLedger(root,snapshot,ledger,views,state,catalog,reportPath,extraEntries=[]) {
  validateLedger(ledger,(await loadConfig(root)).config);
  const ledgerText=await optionalRead(await safePath(root,MEMORY_PATH));
  assert((ledgerText===null?null:hash(ledgerText))===snapshot.ledgerHash,'Ledger changed before commit');
  const stateText=await optionalRead(await safePath(root,STATE_PATH));
  assert(hash(stateText===null?{version:1,documents:{},queue:{},tick:0}:JSON.parse(stateText))===snapshot.expectedStateHash,'Curation state changed before transaction');
  const agents=await optionalRead(await safePath(root,'AGENTS.md'));
  const entries=[...extraEntries,{path:MEMORY_PATH,previousContent:ledgerText,nextContent:JSON.stringify(ledger,null,2)+'\n'},...catalog.documents.map(d=>({path:d.path,previousContent:snapshot.documents[d.id].content,nextContent:views[d.path]})),{path:'AGENTS.md',previousContent:agents,nextContent:renderAgents(agents,catalog)},{path:STATE_PATH,previousContent:stateText,nextContent:JSON.stringify(state,null,2)+'\n'}];
  await commitBatch(root,entries,reportPath);
}
export async function migrate(cwd) {
  const root=await repositoryRoot(cwd);
  return withLock(root,async()=>{
    await initialize(root);
    const {config}=await loadConfig(root),{catalog}=await loadRegistry(root);
    const snapshot=await collect(root,config,catalog),state=await loadState(root);
    snapshot.expectedStateHash=hash(state);
    const imported=importDocuments(snapshot.ledger,snapshot.documents,config);
    const views=renderViews(imported.ledger,catalog,config);
    imported.ledger.projections=projectionHashes(views,catalog);
    // Migration never certifies the old source baselines or imported policy.
    for(const doc of catalog.documents) {
      delete state.documents[doc.id];
      state.queue[doc.id]={firstTick:state.tick,signature:'migration'};
    }
    const latest=await collect(root,config,catalog);
    assert(latest.ledgerHash===snapshot.ledgerHash&&catalog.documents.every(d=>latest.documents[d.id].hash===snapshot.documents[d.id].hash),'Migration inputs changed; retry');
    if(!imported.backups.length&&snapshot.ledger&&catalog.documents.every(d=>snapshot.documents[d.id].hash===imported.ledger.projections[d.id]))return {imported:[],backups:[],message:'Memory views are already current; nothing to migrate.'};
    await persistLedger(root,snapshot,imported.ledger,views,state,catalog,'migration',imported.backups);
    return {imported:imported.imported,backups:imported.backups.map(b=>b.path),message:'Originals archived; imported claims remain unverified pending investigation.'};
  });
}
export async function context(cwd,query={}) {
  const view=await inspect(cwd);
  assert(view.snapshot.ledger,'Initialize or migrate the memory ledger first');
  assert(!view.viewDrift.length,'Generated views were edited; migrate the corrections before relying on contextual retrieval');
  return {...resolveApplicable(view.snapshot.ledger,{maxChars:view.config.maxContextChars,...query}),pendingDomains:view.jobs.filter(j=>j.routing==='inspect').map(j=>j.domain)};
}
export async function memoryHistory(cwd,id) {
  const {snapshot}=await inspect(cwd);
  assert(snapshot.ledger,'Initialize or migrate the memory ledger first');
  if(!id)return {revision:snapshot.ledger.revision,records:snapshot.ledger.records};
  const record=snapshot.ledger.records.find(r=>r.id===id);assert(record,`Unknown memory: ${id}`);
  return {record,events:snapshot.ledger.events.filter(e=>e.recordId===id)};
}
