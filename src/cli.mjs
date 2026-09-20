#!/usr/bin/env node
import { setup,inspect,run,setAuto,capture,captureMuse,migrate,context,memoryHistory } from './engine.mjs';
import { publicJob } from './router.mjs';
import { repositoryRoot } from './collector.mjs';
import { cancelBackgroundRun } from './daemon.mjs';
import { unlock } from './store.mjs';
import { readFile } from 'node:fs/promises';
import { isMuseSession, parseMuseRecords, museSessionId, museWorkspaceRoot, museToPiEntries } from './muse-adapter.mjs';
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
    if(!arg) throw new Error('capture requires a session JSONL path');
    const text=await readFile(arg,'utf8');
    let piEntries=null,piError=null;
    try { piEntries=text.split('\n').filter(Boolean).map(line=>JSON.parse(line)); } catch(e) { piError=e; }
    const header=piEntries?.find(e=>e.type==='session');
    if(header?.id && header?.cwd) {
      if(await repositoryRoot(header.cwd)!==await repositoryRoot(cwd)) throw new Error('Session header must identify this Git repository');
      await capture(cwd,header.id,piEntries);result={captured:header.id,source:'pi',entries:piEntries.length};
    } else if(isMuseSession(text)) {
      const records=parseMuseRecords(text);
      const sessionId=museSessionId(records);
      const workspace=museWorkspaceRoot(records);
      let matches=false;
      try { matches=!!workspace && await repositoryRoot(workspace)===await repositoryRoot(cwd); } catch { matches=false; }
      if(!matches) throw new Error('Session must contain entries from this Git repository');
      const entries=museToPiEntries(records);
      await captureMuse(cwd,sessionId,entries);result={captured:sessionId,source:'muse',entries:entries.length};
    } else if(piError) throw piError;
    else throw new Error('Unrecognized session format');
  } else throw new Error('Usage: hindsight [init|migrate|context|memory|scan|run|force|auto|cancel|capture|unlock] [arguments] [--cwd repository]');
  console.log(JSON.stringify(result,null,2));
} catch(error) { console.error(error.message ?? error);process.exitCode=1; }
