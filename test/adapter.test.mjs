import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fixture,baseline,complete } from './helpers.mjs';
import { route } from '../src/router.mjs';
import { Investigation } from '../src/investigation.mjs';
import { runPiCurator,investigationTools } from '../src/pi-sdk.mjs';
import { DEFAULTS, loadConfig } from '../src/config.mjs';
import { setup, setAuto } from '../src/engine.mjs';
import extension from '../extension.ts';

async function makeLedger(t){const f=await fixture(t);const {snapshot,state}=await baseline(f);return new Investigation(route(snapshot,state,f.catalog,f.config,{force:true,domain:'dependencies'})[0],snapshot,f.config);}
// DEFAULTS now configure a dedicated curator model, so the runtime must resolve it.
const mockRuntime={getModel:()=>({provider:'mock',id:'mock'})};
function mockSdk(inv,{extraTool=false,empty=false,turns=1,hang=false}={}){
  const observed={};let subscriber;
  return {observed,sdk:{
    SettingsManager:{inMemory:settings=>(observed.settings=settings,{})},
    SessionManager:{inMemory:cwd=>({cwd})},
    DefaultResourceLoader:class{
      constructor(options){observed.loader=options;}
      async reload(){}
      getExtensions(){return{extensions:[],errors:[]};}
    },
    async createAgentSession(options){observed.options=options;return{session:{
      agent:{state:{tools:[...options.customTools,...(extraTool?[{name:'bash'}]:[])]}},messages:[],model:{provider:'mock',id:'mock'},
      subscribe(fn){subscriber=fn;return()=>{observed.unsubscribed=true;};},
      async prompt(){if(hang)return new Promise(()=>{});for(let i=0;i<turns;i++)subscriber({type:'turn_start'});if(!empty)complete(inv);},
      async abort(){observed.aborted=true;},dispose(){observed.disposed=true;}
    }};}
  }};
}
test('Pi SDK adapter uses isolated in-memory sessions and exactly the five investigation tools',async t=>{
  await mkdir(new URL('../.test-work/',import.meta.url),{recursive:true});
  const old=process.env.TMPDIR;process.env.TMPDIR=new URL('../.test-work/',import.meta.url).pathname;t.after(()=>{if(old===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=old;});
  const inv=await makeLedger(t);const {sdk,observed}=mockSdk(inv);
  const metrics=await runPiCurator(inv,{sdk,modelRuntime:mockRuntime});
  assert.equal(metrics.turns,1);assert.equal(observed.loader.noExtensions,true);
  assert.deepEqual(observed.options.tools,['list_investigation','read_evidence','add_check','resolve_check','submit_investigation']);
  assert.equal(observed.disposed,true);assert.equal(observed.unsubscribed,true);
});
test('adapter rejects a missing submission, unexpected write tool, and exhausted turn budget',async t=>{
  const old=process.env.TMPDIR;process.env.TMPDIR=new URL('../.test-work/',import.meta.url).pathname;t.after(()=>{if(old===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=old;});
  let inv=await makeLedger(t);let mock=mockSdk(inv,{empty:true});
  await assert.rejects(()=>runPiCurator(inv,{sdk:mock.sdk,modelRuntime:mockRuntime}),/without submitting/);
  inv=await makeLedger(t);mock=mockSdk(inv,{extraTool:true});await assert.rejects(()=>runPiCurator(inv,{sdk:mock.sdk,modelRuntime:mockRuntime}),/Unexpected curator tools/);
  inv=await makeLedger(t);inv.config.maxTurns=1;mock=mockSdk(inv,{turns:2});await assert.rejects(()=>runPiCurator(inv,{sdk:mock.sdk,modelRuntime:mockRuntime}),/maxTurns/);assert.equal(mock.observed.aborted,true);
});
test('tool layer propagates invalid evidence errors and terminates only on accepted submission',async t=>{
  const inv=await makeLedger(t);const tools=investigationTools(inv);
  await assert.rejects(()=>tools.find(t=>t.name==='read_evidence').execute('call',{id:'../../secret'}),/Unavailable evidence/);
  await assert.rejects(()=>tools.find(t=>t.name==='submit_investigation').execute('call',{summary:'Premature completion attempt.'}),/every required/);
});
test('extension registers documented command and lifecycle hooks without loading SDK',()=>{
  const events=[],commands=[];extension({on:(event,handler)=>events.push([event,handler]),registerCommand:(name,options)=>commands.push([name,options])});
  assert.equal(commands[0][0],'hindsight');assert.deepEqual(events.map(e=>e[0]),['agent_end','before_agent_start']);
});
test('hindsight is primary with deprecated knowledge alias sharing one handler',()=>{
  const commands=[];extension({on:()=>{},registerCommand:(name,options)=>commands.push([name,options])});
  assert.deepEqual(commands.map(c=>c[0]),['hindsight','knowledge']);
  assert.equal(commands[0][1].handler,commands[1][1].handler);
  assert.match(commands[1][1].description,/Deprecated/);
});
test('fresh init defaults to automatic run mode',async t=>{
  assert.equal(DEFAULTS.auto,'run');
  const f=await fixture(t);
  const {config}=await loadConfig(f.root);
  assert.equal(config.auto,'run');
  const result=await setup(f.root);
  assert.equal(result.auto,'run');
  assert.match(result.message,/Automatic mode/);
  assert.match(result.message,/\/hindsight scan/);
  assert.match(result.message,/\/hindsight run/);
});
test('lifecycle hooks inject index by default and stay hands-off when auto is off',async t=>{
  const events=new Map(),commands=new Map();
  extension({on:(event,handler)=>events.set(event,handler),registerCommand:(name,options)=>commands.set(name,options)});
  const f=await fixture(t);
  // Fresh fixture defaults to auto run: before_agent_start injects the domain index.
  const auto=await events.get('before_agent_start')({prompt:'work',systemPrompt:'base'},{cwd:f.root});
  assert.match(auto.systemPrompt,/Engineering memory lives/);
  // Explicit off restores hands-off behavior: agent_end must no-op without a session manager,
  // and before_agent_start must not inject an index.
  await setAuto(f.root,'off');
  await events.get('agent_end')(null,{cwd:f.root});
  const before=await events.get('before_agent_start')({prompt:'work',systemPrompt:'base'},{cwd:f.root});
  assert.equal(before,undefined);
});
test('deadline rejects even if a provider does not settle its prompt after abort',async t=>{
  const old=process.env.TMPDIR;process.env.TMPDIR=new URL('../.test-work/',import.meta.url).pathname;t.after(()=>{if(old===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=old;});
  const inv=await makeLedger(t);inv.config.timeoutMs=20;const {sdk,observed}=mockSdk(inv,{hang:true});
  await assert.rejects(()=>runPiCurator(inv,{sdk,modelRuntime:mockRuntime}),/timeoutMs/);assert.equal(observed.aborted,true);assert.equal(observed.disposed,true);
});
