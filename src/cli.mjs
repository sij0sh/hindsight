#!/usr/bin/env node
import { setup,inspect,run,setAuto,capture,migrate,context,memoryHistory } from './engine.mjs';
import { publicJob } from './router.mjs';
import { repositoryRoot } from './collector.mjs';
import { cancelBackgroundRun } from './daemon.mjs';
import { unlock } from './store.mjs';
import { readFile } from 'node:fs/promises';
import { parseCommand } from './commands.mjs';

try {
  const parsed=parseCommand(process.argv.slice(2));const {command,arg}=parsed,cwd=parsed.cwd??process.cwd();
  let result;
  if(command==='init') {result=await setup(cwd);if(parsed.migrate)result=await migrate(cwd);}
  else if(command==='migrate') result=await migrate(cwd);
  else if(command==='context') result=await context(cwd,parsed.query);
  else if(command==='memory') result=await memoryHistory(cwd,arg);
  else if(command==='auto') result={auto:await setAuto(cwd,arg)};
  else if(command==='unlock') result={message:await unlock(await repositoryRoot(cwd))};
  else if(command==='scan' || command==='status') { const view=await inspect(cwd,{domain:arg}); result={initialized:view.initialized,migrationRequired:view.migrationRequired,viewDrift:view.viewDrift,head:view.snapshot.head,jobs:view.jobs.map(publicJob)}; }
  else if(command==='run' || command==='force') {
    const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
    result=await run(cwd,{domain:arg,force:command==='force',manual:true,signal:controller.signal});
    if(result.results.some(r=>['failed','blocked'].includes(r.result))) process.exitCode=2;
  } else if(command==='cancel') {
    result={message:await cancelBackgroundRun(await repositoryRoot(cwd))};
  } else if(command==='capture') {
    if(!arg) throw new Error('capture requires a Pi JSONL session path');
    const entries=(await readFile(arg,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const header=entries.find(e=>e.type==='session');
    if(!header?.id || !header?.cwd || await repositoryRoot(header.cwd)!==await repositoryRoot(cwd)) throw new Error('Session header must identify this Git repository');
    await capture(cwd,header.id,entries);result={captured:header.id};
  } else throw new Error('Usage: hindsight [init|migrate|context|memory|scan|run|force|auto|cancel|capture|unlock] [arguments] [--cwd repository]');
  console.log(JSON.stringify(result,null,2));
} catch(error) { console.error(error.message ?? error);process.exitCode=1; }
