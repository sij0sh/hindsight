#!/usr/bin/env node
import { setup,inspect,run,setAuto,capture } from './engine.mjs';
import { publicJob } from './router.mjs';
import { repositoryRoot } from './collector.mjs';
import { unlock } from './store.mjs';
import { readFile } from 'node:fs/promises';

const args=process.argv.slice(2);
let cwd=process.cwd();
const cwdIndex=args.indexOf('--cwd');
if(cwdIndex>=0){ if(!args[cwdIndex+1]) throw new Error('--cwd needs a path'); cwd=args[cwdIndex+1];args.splice(cwdIndex,2); }
const [command='scan',arg,...rest]=args;
try {
  if(rest.length) throw new Error('Unexpected arguments');
  let result;
  if(command==='init') result=await setup(cwd);
  else if(command==='auto') result={auto:await setAuto(cwd,arg)};
  else if(command==='unlock') result={message:await unlock(await repositoryRoot(cwd))};
  else if(command==='scan' || command==='status') { const view=await inspect(cwd,{domain:arg}); result={initialized:view.initialized,head:view.snapshot.head,jobs:view.jobs.map(publicJob)}; }
  else if(command==='run' || command==='force') {
    const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
    result=await run(cwd,{domain:arg,force:command==='force',manual:true,signal:controller.signal});
    if(result.results.some(r=>['failed','blocked'].includes(r.result))) process.exitCode=2;
  } else if(command==='capture') {
    if(!arg) throw new Error('capture requires a Pi JSONL session path');
    const entries=(await readFile(arg,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const header=entries.find(e=>e.type==='session');
    if(!header?.id || !header?.cwd || await repositoryRoot(header.cwd)!==await repositoryRoot(cwd)) throw new Error('Session header must identify this Git repository');
    await capture(cwd,header.id,entries);result={captured:header.id};
  } else throw new Error('Usage: hindsight [init|scan|run|force|auto|capture|unlock] [domain/mode/session.jsonl] [--cwd repository]');
  console.log(JSON.stringify(result,null,2));
} catch(error) { console.error(error.message ?? error);process.exitCode=1; }
