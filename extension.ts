import { setup, inspect, run, capture, setAuto, hindsightIndex, migrate, context, memoryHistory } from './src/engine.mjs';
import { unlock } from './src/store.mjs';
import { repositoryRoot } from './src/collector.mjs';
import { loadConfig, loadRegistry } from './src/config.mjs';
import { parseCommand, tokenize } from './src/commands.mjs';
import { resolveApplicable } from './src/memory.mjs';
import { formatContext } from './src/views.mjs';

/** Pi extension entrypoint. SDK imports remain lazy until a curator is routed. */
export default function hindsight(pi) {
  let active = null;
  const notify = (ctx, text, level = 'info') => { if (ctx.hasUI) ctx.ui.notify(text,level); };
  const sessionCapture = async ctx => capture(ctx.cwd,ctx.sessionManager.getSessionId(),ctx.sessionManager.getBranch());
  const execute = async (ctx,options) => {
    if (active) throw new Error('A knowledge investigation is already running. Use /hindsight cancel.');
    const controller = new AbortController(); active = controller;
    try {
      return await run(ctx.cwd,{...options,model:ctx.model,signal:controller.signal,onProgress:result => {
        if (ctx.hasUI) ctx.ui.setStatus('hindsight',`${result.domain}: ${result.status ?? result.result}`);
      }});
    } finally { active=null; if (ctx.hasUI) ctx.ui.setStatus('hindsight',undefined); }
  };
  const handler = async (args,ctx) => {
    try {
      const parsed=parseCommand(tokenize(args));const {command,arg}=parsed;
      if (command === 'cancel') { active?.abort(); notify(ctx,'Cancellation requested.'); return; }
      if (ctx.isProjectTrusted && !ctx.isProjectTrusted()) throw new Error('Trust this project in Pi before using repository-local knowledge configuration.');
      if (command === 'init') { const result=await setup(ctx.cwd);notify(ctx,parsed.migrate?(await migrate(ctx.cwd)).message:result.message);return; }
      if (command === 'migrate') {notify(ctx,(await migrate(ctx.cwd)).message);return;}
      if (command === 'context') {notify(ctx,formatContext(await context(ctx.cwd,parsed.query)));return;}
      if (command === 'memory') {notify(ctx,JSON.stringify(await memoryHistory(ctx.cwd,arg),null,2));return;}
      if (command === 'auto') { notify(ctx,`Automatic hindsight mode: ${await setAuto(ctx.cwd,arg)}`); return; }
      if (command === 'unlock') { notify(ctx,await unlock(await repositoryRoot(ctx.cwd))); return; }
      if (command === 'scan' || command === 'status') {
        const view = await inspect(ctx.cwd,{domain:arg});
        notify(ctx,[...(view.migrationRequired?['Migration required: /hindsight migrate']:[]),...(view.viewDrift.length?[`View edits require import: ${view.viewDrift.join(', ')}`]:[]),...view.jobs.map(j => `${j.domain}: ${j.status}${j.conflicts.length?`; ${j.conflicts.length} open conflicts`:''}${j.triggers.length ? ` (${j.triggers.map(t=>t.id).join(', ')})` : ''}`)].join('\n'));
        return;
      }
      if (command === 'run' || command === 'force') {
        await ctx.waitForIdle();
        await sessionCapture(ctx);
        const result = await execute(ctx,{manual:true,force:command === 'force',domain:arg});
        notify(ctx,result.results.length ? result.results.map(r=>`${r.domain}: ${r.result}${r.error ? ` (${r.error})` : ''}`).join('\n') : 'No inspections are pending.');
        return;
      }
      throw new Error('Use /hindsight init, migrate, context --paths PATH, memory [ID], scan, run [domain], force [domain], auto off|scan|run, cancel, or unlock.');
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
    if (active || ctx.isProjectTrusted && !ctx.isProjectTrusted()) return;
    try {
      const root = await repositoryRoot(ctx.cwd);
      const {config,initialized} = await loadConfig(root);
      if (!initialized || config.auto === 'off') return;
      await sessionCapture(ctx);
      const result = await execute(ctx,{manual:false,event:true,scanOnly:config.auto !== 'run'});
      const needsAttention = result.results.filter(r => ['blocked','failed'].includes(r.result));
      if (needsAttention.length) notify(ctx,needsAttention.map(r=>`${r.domain}: ${r.result}. See ${r.reportPath}`).join('\n'),'warning');
      else if (ctx.hasUI) ctx.ui.setStatus('hindsight',`${result.pending.length} hindsight domains pending`);
    } catch (error) { notify(ctx,`Hindsight: ${error.message ?? error}`,'warning'); }
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
  pi.on('session_shutdown',async () => { active?.abort(); });
}
