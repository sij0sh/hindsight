import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert } from './util.mjs';
import { OUTCOMES, CLASSIFICATIONS, curatorPrompt } from './investigation.mjs';
import { KINDS, DOMAINS } from './memory.mjs';

// JSON Schema is the runtime representation accepted by Pi tools; no extra schema dependency.
const str = { type:'string' };
const strings = { type:'array', items:str };
const object = (properties, required = Object.keys(properties)) => ({ type:'object', properties, required, additionalProperties:false });
const scopeSchema=object({global:{type:'boolean'},paths:strings,symbols:strings,concepts:strings});
const support={checkIds:strings,evidenceRefs:strings};
const claim={kind:{type:'string',enum:KINDS.filter(k=>k!=='conflict')},domains:{type:'array',items:{type:'string',enum:DOMAINS}},statement:str,scope:scopeSchema,exposeTo:strings,reason:str,constraint:str,removalCondition:str,removalSignals:{type:'array',items:object({type:{type:'string',enum:['paths_absent','path_present']},path:str})}};
const claimRequired=['kind','domains','statement','scope'];
const array=schema=>({type:'array',items:schema});
export const memoryOpsSchema=object({
  create:array(object({...claim,...support,clientId:str},[...claimRequired,...Object.keys(support)])),
  scarCandidates:array(object({...claim,kind:{type:'string',enum:['scar']},...support,clientId:str},['domains','statement','scope','reason','constraint','removalCondition',...Object.keys(support)])),
  reinforce:array(object({target:str,reason:str,reviewedScope:scopeSchema,atomicityReviewed:{type:'boolean'},...support},['target','reason',...Object.keys(support)])),
  supersede:array(object({target:str,reason:str,replacement:object(claim,claimRequired),...support})),
  invalidate:array(object({target:str,reason:str,status:{type:'string',enum:['obsolete','resolved','unverified']},...support})),
  conflict:array(object({statement:str,domains:{type:'array',items:{type:'string',enum:DOMAINS}},scope:scopeSchema,targets:strings,reason:str,possibleADR:str,clientId:str,...support},['statement','domains','scope','targets','reason',...Object.keys(support)])),
  resolve:array(object({target:str,reason:str,resolution:{type:'string',enum:['keep','retired']},...support}))
},[]);
export function investigationTools(investigation) {
  const tool = (name,description,parameters,execute,terminate=false) => ({
    name, label:name, description, parameters,
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const result = execute(params);
      return { content:[{ type:'text', text:JSON.stringify(result) }], details:{}, ...(terminate ? { terminate:true } : {}) };
    }
  });
  return [
    tool('list_investigation','List required/derived checks and available immutable evidence IDs.',object({}),() => investigation.list()),
    tool('read_evidence','Read a bounded evidence chunk. Cite the returned receipt ref. Follow nextOffset to read the rest.',object({ id:str,start:{type:'integer',minimum:0},length:{type:'integer',minimum:1} },['id']),p => investigation.read(p.id,p.start,p.length)),
    tool('add_check','Append a derived criterion with an existing parent and a specific reason.',object({id:str,parent:str,question:str,reason:str}),p => investigation.add(p)),
    tool('resolve_check','Resolve a criterion with concise findings and inspected evidence receipt references.',object({id:str,outcome:{type:'string',enum:OUTCOMES},finding:str,evidenceRefs:strings,confidence:{type:'string',enum:['high','medium','low']},classification:{type:'string',enum:CLASSIFICATIONS}}),p => investigation.resolve(p)),
    tool('submit_investigation','Reconcile atomic scoped memories. No Markdown writes. Link ADR proposals to conflict IDs or clientIds.',object({summary:str,memoryOps:memoryOpsSchema,adrs:array(object({title:str,context:str,options:strings,checkIds:strings,conflictRefs:strings}))},['summary','memoryOps']),p => investigation.submit(p),true)
  ];
}

export async function createIsolatedSession(sdk, investigation, { model, modelRuntime } = {}) {
  const isolated = await mkdtemp(join(tmpdir(),'hindsight-'));
  let createdSession;
  try {
    const settingsManager = sdk.SettingsManager.inMemory({ compaction:{enabled:false}, retry:{enabled:false} });
    const loader = new sdk.DefaultResourceLoader({
      cwd:isolated, agentDir:isolated, settingsManager,
      noExtensions:true, noSkills:true, noPromptTemplates:true, noThemes:true,
      agentsFilesOverride:() => ({agentsFiles:[]}),
      skillsOverride:() => ({skills:[],diagnostics:[]}),
      promptsOverride:() => ({prompts:[],diagnostics:[]}),
      systemPromptOverride:() => curatorPrompt(investigation.job.domain)
    });
    await loader.reload();
    const extensions = loader.getExtensions();
    assert(extensions.extensions.length === 0 && extensions.errors.length === 0, 'Curator resource isolation failed');
    const customTools = investigationTools(investigation);
    const result = await sdk.createAgentSession({
      cwd:isolated, agentDir:isolated, model, modelRuntime, thinkingLevel:'low',
      resourceLoader:loader, sessionManager:sdk.SessionManager.inMemory(isolated), settingsManager,
      tools:customTools.map(t => t.name), customTools
    });
    createdSession=result.session;
    const active = result.session.agent.state.tools.map(t => t.name).sort();
    assert(JSON.stringify(active) === JSON.stringify(customTools.map(t => t.name).sort()), 'Unexpected curator tools; refusing to run');
    return { ...result, cleanup:async () => { result.session.dispose(); await rm(isolated,{recursive:true,force:true}); } };
  } catch (e) { createdSession?.dispose(); await rm(isolated,{recursive:true,force:true}); throw e; }
}

export async function runPiCurator(investigation, options = {}) {
  const sdk = options.sdk ?? await import('@earendil-works/pi-coding-agent');
  const runtime = options.modelRuntime ?? await sdk.ModelRuntime.create({ signal:AbortSignal.timeout(15000) });
  const config = investigation.config;
  const model = config.model ? runtime.getModel(config.provider,config.model) : options.model;
  assert(!config.model || model, `Configured Pi model not found: ${config.provider}/${config.model}`);
  const {session,cleanup} = await createIsolatedSession(sdk,investigation,{model,modelRuntime:runtime});
  let turns = 0, failure;
  let rejectAbort;
  const aborted = new Promise((_,reject)=>{rejectAbort=reject;});
  // Install a rejection handler even if cancellation occurs before prompt() starts.
  void aborted.catch(()=>{});
  const stop = reason => { failure ??= reason; rejectAbort(new Error(reason)); void session.abort().catch(()=>{}); };
  const abort = () => stop('Curation cancelled');
  options.signal?.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(() => stop('Curator exceeded timeoutMs'),config.timeoutMs);
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'turn_start' && ++turns > config.maxTurns) stop('Curator exceeded maxTurns');
  });
  try {
    if (options.signal?.aborted) abort();
    assert(!failure,failure);
    await Promise.race([session.prompt(`Investigate ${investigation.job.domain}. Start with list_investigation. Complete every applicable check and submit your evidence-backed result.`,{expandPromptTemplates:false}),aborted]);
    assert(!failure,failure);
    assert(investigation.submission,'Pi ended without submitting a complete investigation');
    const usage = session.messages.filter(m => m.role === 'assistant').reduce((a,m) => ({ input:a.input+(m.usage?.input ?? 0),output:a.output+(m.usage?.output ?? 0),cost:a.cost+(m.usage?.cost?.total ?? 0) }),{input:0,output:0,cost:0});
    return {turns,usage,model:session.model ? `${session.model.provider}/${session.model.id}` : null};
  } finally {
    clearTimeout(timer); unsubscribe(); options.signal?.removeEventListener('abort',abort); await cleanup();
  }
}
