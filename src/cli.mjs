#!/usr/bin/env node
import { setup,inspect,run,setAuto,capture,captureMuse,captureClaude,importSessions,migrate,context,memoryHistory } from './engine.mjs';
import { publicJob } from './router.mjs';
import { repositoryRoot } from './collector.mjs';
import { cancelBackgroundRun } from './daemon.mjs';
import { unlock } from './store.mjs';
import { readFile } from 'node:fs/promises';
import { isMuseSession, parseMuseRecords, museSessionId, museWorkspaceRoot, museToPiEntries } from './muse-adapter.mjs';
import { isClaudeSession } from './claude-adapter.mjs';
import { adaptClaudeLines } from './claude-import.mjs';
import { parseJsonLines, repositoryMatcher } from './session-import.mjs';
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
  } else if(command==='import') {
    result=await importSessions(cwd);
  } else if(command==='capture') {
    if(!arg) throw new Error('capture requires a session JSONL path');
    const text=await readFile(arg,'utf8');
    // Tolerant parse: a live transcript may end mid-line.
    const lines=parseJsonLines(text);
    const header=lines.find(e=>e.type==='session');
    if(header?.id && header?.cwd) {
      if(await repositoryRoot(header.cwd)!==await repositoryRoot(cwd)) throw new Error('Session header must identify this Git repository');
      result={captured:header.id,source:'pi',entries:lines.length,...await capture(cwd,header.id,lines,{header})};
    } else if(isMuseSession(text)) {
      const records=parseMuseRecords(text);
      const sessionId=museSessionId(records);
      const workspace=museWorkspaceRoot(records);
      let matches=false;
      try { matches=!!workspace && await repositoryRoot(workspace)===await repositoryRoot(cwd); } catch { matches=false; }
      if(!matches) throw new Error('Session must contain entries from this Git repository');
      const entries=museToPiEntries(records);
      result={captured:sessionId,source:'muse',entries:entries.length,...await captureMuse(cwd,sessionId,entries)};
    } else if(isClaudeSession(lines)) {
      const matches=repositoryMatcher(await repositoryRoot(cwd));
      const sessions=[];
      for(const session of adaptClaudeLines(lines,arg)) if(await matches(session.cwd)) sessions.push(session);
      if(!sessions.length) throw new Error('Session must contain entries from this Git repository');
      result={captured:sessions.map(s=>s.sessionId),source:'claude',entries:0,added:0,changed:0,chars:0};
      for(const session of sessions) {
        const counts=await captureClaude(cwd,session.sessionId,session.entries);
        result.entries+=session.entries.length;
        for(const key of ['added','changed','chars'])result[key]+=counts?.[key]??0;
      }
    } else throw new Error('Unrecognized session format');
  } else throw new Error('Usage: hindsight [init|migrate|context|memory|scan|run|force|auto|cancel|capture|import|unlock] [arguments] [--cwd repository]');
  console.log(JSON.stringify(result,null,2));
} catch(error) { console.error(error.message ?? error);process.exitCode=1; }
