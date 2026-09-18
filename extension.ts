import { setup, inspect, run, capture, setAuto, hindsightIndex, migrate, context, memoryHistory } from './src/engine.mjs';
import { unlock } from './src/store.mjs';
import { repositoryRoot } from './src/collector.mjs';
import { loadConfig, loadRegistry } from './src/config.mjs';
import { parseCommand, tokenize } from './src/commands.mjs';
import { resolveApplicable } from './src/memory.mjs';
import { formatContext } from './src/views.mjs';
import { backgroundRunStatus, cancelBackgroundRun, spawnDetachedRun } from './src/daemon.mjs';

/** Pi extension entrypoint. Curator runs execute in a detached background process; Pi only triggers. */
export default function hindsight(pi) {
  const notify = (ctx, text, level = 'info') => { if (ctx.hasUI) ctx.ui.notify(text,level); };
  // Session capture takes the run lock briefly. When a background run holds
  // it, evidence capture is skipped: the active run already snapshotted.
  const sessionCaptureBestEffort = async ctx => {
    try { await capture(ctx.cwd,ctx.sessionManager.getSessionId(),ctx.sessionManager.getBranch()); }
    catch (error) { if (!/run\.lock/.test(String(error?.message ?? error))) throw error; }
  };
  const handler = async (args,ctx) => {
    try {
      const parsed=parseCommand(tokenize(args));const {command,arg}=parsed;
      if (command === 'cancel') { notify(ctx,await cancelBackgroundRun(await repositoryRoot(ctx.cwd))); return; }
      if (ctx.isProjectTrusted && !ctx.isProjectTrusted()) throw new Error('Trust this project in Pi before using repository-local knowledge configuration.');
      if (command === 'init') { const result=await setup(ctx.cwd);notify(ctx,parsed.migrate?(await migrate(ctx.cwd)).message:result.message);return; }
      if (command === 'migrate') {notify(ctx,(await migrate(ctx.cwd)).message);return;}
      if (command === 'context') {notify(ctx,formatContext(await context(ctx.cwd,parsed.query)));return;}
      if (command === 'memory') {notify(ctx,JSON.stringify(await memoryHistory(ctx.cwd,arg),null,2));return;}
      if (command === 'auto') { notify(ctx,`Automatic hindsight mode: ${await setAuto(ctx.cwd,arg)}`); return; }
      if (command === 'unlock') { notify(ctx,await unlock(await repositoryRoot(ctx.cwd))); return; }
      if (command === 'scan' || command === 'status') {
        const view = await inspect(ctx.cwd,{domain:arg});
        const background = await backgroundRunStatus(view.root);
        notify(ctx,[(background && background.alive !== false ? `Background run active: pid ${background.pid ?? 'unknown'} since ${background.startedAt ?? 'unknown'}. Logs: .agents/curation/logs/` : null),...(view.migrationRequired?['Migration required: /hindsight migrate']:[]),...(view.viewDrift.length?[`View edits require import: ${view.viewDrift.join(', ')}`]:[]),...view.jobs.map(j => `${j.domain}: ${j.status}${j.conflicts.length?`; ${j.conflicts.length} open conflicts`:''}${j.triggers.length ? ` (${j.triggers.map(t=>t.id).join(', ')})` : ''}`)].filter(Boolean).join('\n'));
        return;
      }
      if (command === 'run' || command === 'force') {
        await sessionCaptureBestEffort(ctx);
        const started = await spawnDetachedRun({cwd:ctx.cwd,command,domain:arg});
        notify(ctx,`Hindsight ${command}${arg ? ` ${arg}` : ''} started in the background (pid ${started.pid}).\nLog: ${started.log}\nUse /hindsight scan for progress, /hindsight cancel to stop it.`);
        return;
      }
      throw new Error('Use /hindsight init, migrate, context --paths PATH, memory [ID], scan, run [domain], force [domain], auto off|scan|run, cancel, status, or unlock.');
    } catch (error) { notify(ctx,String(error.message ?? error),'error'); }
  };
  pi.registerCommand('hindsight',{
    description:'Engineering memory: init | migrate | scan | context --paths PATH | memory [ID] | run [domain] | force [domain] | auto off/scan/run | cancel | unlock',
    handler
  });
  // Deprecated alias for one release. Use /hindsight.
  pi.registerCommand('knowledge',{
    description:'Deprecated alias for /hindsight. Use /hindsight instead.',
    handler
  });
  pi.on('agent_end',async (_event,ctx) => {
    if (ctx.isProjectTrusted && !ctx.isProjectTrusted()) return;
    try {
      const root = await repositoryRoot(ctx.cwd);
      const {config,initialized} = await loadConfig(root);
      if (!initialized || config.auto === 'off') return;
      const background = await backgroundRunStatus(root);
      if (background && background.alive !== false) return;
      await sessionCaptureBestEffort(ctx);
      if (config.auto !== 'run') {
        await run(root,{manual:false,event:true,scanOnly:true});
        return;
      }
      try {
        await spawnDetachedRun({cwd:root,command:'run'});
      } catch (error) {
        // A concurrent trigger won the lock; the other run covers this event.
        if (!/already active|stale lock|run\.lock/.test(String(error?.message ?? error))) notify(ctx,`Hindsight: ${error.message ?? error}`,'warning');
      }
    } catch (error) {
      if (!/run\.lock/.test(String(error?.message ?? error))) notify(ctx,`Hindsight: ${error.message ?? error}`,'warning');
    }
  });
  pi.on('before_agent_start',async (event,ctx) => {
    if (ctx.isProjectTrusted && !ctx.isProjectTrusted()) return;
    try {
      const root=await repositoryRoot(ctx.cwd);
      const {initialized,config}=await loadConfig(root);
      if (!initialized || config.auto === 'off') return;
      const {catalog}=await loadRegistry(root);
      if(config.contextInjection) {
        const view=await inspect(root);
        if(view.snapshot.ledger&&!view.viewDrift.length) {
          // Only explicit repository-relative paths in the current prompt, not unrelated dirty files.
          const mentioned=new Set((event.prompt??'').split(/\s+/).map(t=>t.replace(/^[`'"(@]+|[`'"),:;.!?]+$/g,'')));
          const paths=Object.keys(view.snapshot.files).filter(p=>mentioned.has(p));
          if(paths.length)return {systemPrompt:`${event.systemPrompt}\n\n${formatContext({...resolveApplicable(view.snapshot.ledger,{paths,maxChars:config.maxContextChars}),pendingDomains:view.jobs.filter(j=>j.routing==='inspect').map(j=>j.domain)})}`};
        }
      }
      return {systemPrompt:`${event.systemPrompt}\n\n${hindsightIndex(catalog)}`};
    } catch { /* A non-Git workspace remains usable; /hindsight reports its actionable error. */ }
  });
}
