import { randomUUID } from 'node:crypto';
import { loadConfig, loadRegistry, initialize, CONFIG_PATH, STATE_PATH } from './config.mjs';
import { collect, repositoryRoot, captureSession } from './collector.mjs';
import { route, schedule, publicJob } from './router.mjs';
import { Investigation } from './investigation.mjs';
import { loadState, withLock, commit } from './store.mjs';
import { assert, hash, optionalRead, safePath, atomicWrite, writeJson } from './util.mjs';

export async function inspect(cwd, options = {}) {
  const root = await repositoryRoot(cwd);
  const {config,initialized} = await loadConfig(root);
  const {catalog} = await loadRegistry(root);
  if (options.domain) assert(catalog.documents.some(d => d.id === options.domain), `Unknown domain: ${options.domain}`);
  const state = await loadState(root);
  const snapshot = await collect(root,config,catalog);
  const jobs = route(snapshot,state,catalog,config,options);
  return {root,config,initialized,catalog,state,snapshot,jobs};
}

export function hindsightIndex(catalog) {
  return ['Engineering knowledge is maintained under .agents/engineering/.',
    'Read AGENT_POLICY.md and the domain documents relevant to your task before making changes.',
    'Documents describe evidence and accepted constraints. Unresolved investigations and proposed ADRs are not accepted policy.',
    ...catalog.documents.map(doc => `- ${doc.id}: ${doc.path}`)].join('\n');
}
// Deprecated alias. Use hindsightIndex.
export const knowledgeIndex = hindsightIndex;
const ROUTING_START = '<!-- hindsight:start -->';
const ROUTING_END = '<!-- hindsight:end -->';
const LEGACY_ROUTING_START = '<!-- pi-knowledge:start -->';
const LEGACY_ROUTING_END = '<!-- pi-knowledge:end -->';
export async function setup(cwd) {
  const root = await repositoryRoot(cwd);
  return withLock(root,async () => {
    await initialize(root);
    const {catalog} = await loadRegistry(root);
    const target = await safePath(root,'AGENTS.md');
    const current = await optionalRead(target) ?? '';
    const block = `${ROUTING_START}\n${hindsightIndex(catalog)}\n${ROUTING_END}`;
    let next;
    if (current.includes(ROUTING_START) || current.includes(ROUTING_END)) {
      assert(current.split(ROUTING_START).length === 2 && current.split(ROUTING_END).length === 2 && current.indexOf(ROUTING_START) < current.indexOf(ROUTING_END), 'Repair malformed hindsight markers in AGENTS.md');
      next = current.slice(0,current.indexOf(ROUTING_START)) + block + current.slice(current.indexOf(ROUTING_END)+ROUTING_END.length);
    } else if (current.includes(LEGACY_ROUTING_START) || current.includes(LEGACY_ROUTING_END)) {
      assert(current.split(LEGACY_ROUTING_START).length === 2 && current.split(LEGACY_ROUTING_END).length === 2 && current.indexOf(LEGACY_ROUTING_START) < current.indexOf(LEGACY_ROUTING_END), 'Repair malformed hindsight markers in AGENTS.md');
      next = current.slice(0,current.indexOf(LEGACY_ROUTING_START)) + block + current.slice(current.indexOf(LEGACY_ROUTING_END)+LEGACY_ROUTING_END.length);
    } else next = `${current}${current && !current.endsWith('\n') ? '\n' : ''}\n${block}\n`;
    if (next !== current) await atomicWrite(root,'AGENTS.md',next);
    return {root,auto:(await loadConfig(root)).config.auto,message:'Initialized engineering knowledge. /knowledge scan shows routing; /knowledge run investigates pending domains; /knowledge auto run enables automatic curation.'};
  });
}
export async function setAuto(cwd, mode) {
  assert(['off','scan','run'].includes(mode),'Choose auto off, scan, or run');
  const root = await repositoryRoot(cwd);
  return withLock(root,async () => {
    const {config,initialized} = await loadConfig(root);
    assert(initialized,'Run /knowledge init first');
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
  assert(initial.initialized,'Run /knowledge init (or hindsight init) first');
  return withLock(root,async () => {
    const initialView = await inspect(root,options);
    const {config,catalog} = initialView;
    let state = initialView.state;
    const selected = schedule(initialView.jobs,state,config,{manual:options.manual !== false,event:options.event === true});
    await writeJson(root,STATE_PATH,state);
    if (options.scanOnly) return {jobs:initialView.jobs.map(publicJob),results:[],pending:Object.keys(state.queue),eligible:selected.map(j => j.domain)};
    const invoke = options.curator ?? (async (...args) => (await import('./pi-sdk.mjs')).runPiCurator(...args));
    const results = [];
    for (const scheduled of selected) {
      if (options.signal?.aborted) break;
      // Prior curators may have changed canonical knowledge. Rebuild cross-document evidence for each job.
      const snapshot = await collect(root,config,catalog);
      const job = route(snapshot,state,catalog,config,{...options,domain:scheduled.domain})[0];
      if (job.routing === 'skip') continue;
      const investigation = new Investigation(job,snapshot,config);
      const id = `${Date.now()}-${randomUUID()}`;
      const reportPath = `.agents/curation/${job.domain}/runs/${id}.json`;
      options.onProgress?.({domain:job.domain,status:'investigating',checks:job.checks.length});
      let metrics = null;
      try {
        assert(!job.sessionBlocked,'A session entry exceeds maxSessionBatchChars; raise the limit before acknowledging it');
        metrics = await invoke(investigation,options);
        assert(investigation.submission,'Curator did not submit an investigation');
        const report = {...investigation.report(),metrics,recordedAt:new Date().toISOString()};
        await writeJson(root,reportPath,report);
        await writeJson(root,`.agents/curation/${job.domain}/last-investigation.json`,{reportPath,...report});
        const {submission} = investigation;
        if (submission.result === 'blocked') {
          state.queue[job.domain] = {...state.queue[job.domain],retryAt:state.tick+config.retryDelayEvents,lastResult:'blocked',reportPath};
          await writeJson(root,STATE_PATH,state);
          results.push({domain:job.domain,result:'blocked',reportPath});
          options.onProgress?.(results.at(-1));
          continue;
        }
        const latest = await collect(root,config,catalog);
        assert(latest.snapshotHash === snapshot.snapshotHash,'Repository or session evidence changed during investigation; retry against the new snapshot');
        for (const doc of catalog.documents) assert(latest.documents[doc.id].hash === snapshot.documents[doc.id].hash, `Canonical ${doc.id} changed during investigation; retry without overwriting it`);
        const previous = state.documents[job.domain];
        const nextState = structuredClone(state);
        nextState.documents[job.domain] = {
          lastCuratedCommit:snapshot.head,
          inputFingerprint:job.inputFingerprint,
          documentFingerprint:hash(submission.nextDocument),
          ruleFingerprint:job.ruleFingerprint,
          files:job.surface,
          sessions:{...(previous?.sessions ?? {}),...Object.fromEntries(job.sessionBatch.map(s => [s.id,s.hash]))},
          churnHash:job.churnHash,
          lastResult:submission.result,
          lastInvestigation:reportPath,
          lastCuratedAt:new Date().toISOString()
        };
        if(job.pendingSessions>job.sessionBatch.length) nextState.queue[job.domain]={...state.queue[job.domain],retryAt:0,lastResult:'session_batch_complete'};
        else delete nextState.queue[job.domain];
        await commit(root,job.document,snapshot.documents[job.domain].content,submission.nextDocument,nextState,reportPath);
        state = nextState;
        results.push({domain:job.domain,result:submission.result,reportPath,metrics});
      } catch (error) {
        const report = {...investigation.report(),metrics,error:String(error.message ?? error),recordedAt:new Date().toISOString()};
        await writeJson(root,reportPath,report);
        await writeJson(root,`.agents/curation/${job.domain}/last-investigation.json`,{reportPath,...report});
        // A partially applied transaction must be recovered before any subsequent job/state write.
        const journal = await optionalRead(await safePath(root,'.agents/curation/transaction.json'));
        if (journal !== null) throw new Error(`Commit interrupted; recovery is required. ${report.error}`);
        state.queue[job.domain] = {...state.queue[job.domain],retryAt:state.tick+config.retryDelayEvents,lastResult:'failed',reportPath};
        await writeJson(root,STATE_PATH,state);
        results.push({domain:job.domain,result:'failed',error:report.error,reportPath});
      }
      options.onProgress?.(results.at(-1));
    }
    return {results,jobs:initialView.jobs.map(publicJob),pending:Object.keys(state.queue)};
  });
}
