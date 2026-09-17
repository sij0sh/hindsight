import { setup, inspect, run, capture, setAuto, hindsightIndex } from './src/engine.mjs';
import { unlock } from './src/store.mjs';
import { repositoryRoot } from './src/collector.mjs';
import { loadConfig, loadRegistry } from './src/config.mjs';

/** Pi extension entrypoint. SDK imports remain lazy until a curator is routed. */
export default function hindsight(pi) {
  let active = null;
  const notify = (ctx, text, level = 'info') => { if (ctx.hasUI) ctx.ui.notify(text,level); };
  const sessionCapture = async ctx => capture(ctx.cwd,ctx.sessionManager.getSessionId(),ctx.sessionManager.getBranch());
  const execute = async (ctx,options) => {
    if (active) throw new Error('A knowledge investigation is already running. Use /knowledge cancel.');
    const controller = new AbortController(); active = controller;
    try {
      return await run(ctx.cwd,{...options,model:ctx.model,signal:controller.signal,onProgress:result => {
        if (ctx.hasUI) ctx.ui.setStatus('hindsight',`${result.domain}: ${result.status ?? result.result}`);
      }});
    } finally { active=null; if (ctx.hasUI) ctx.ui.setStatus('hindsight',undefined); }
  };
  pi.registerCommand('knowledge',{
    description:'Engineering knowledge: init | scan | run [domain] | force [domain] | auto off/scan/run | cancel | unlock',
    handler:async (args,ctx) => {
      const [command='scan',arg,...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (rest.length) throw new Error('Unexpected arguments. Use /knowledge run [domain] or /knowledge force [domain].');
        if (command === 'cancel') { active?.abort(); notify(ctx,'Cancellation requested.'); return; }
        if (ctx.isProjectTrusted && !ctx.isProjectTrusted()) throw new Error('Trust this project in Pi before using repository-local knowledge configuration.');
        if (command === 'init') { notify(ctx,(await setup(ctx.cwd)).message); return; }
        if (command === 'auto') { notify(ctx,`Automatic hindsight mode: ${await setAuto(ctx.cwd,arg)}`); return; }
        if (command === 'unlock') { notify(ctx,await unlock(await repositoryRoot(ctx.cwd))); return; }
        if (command === 'scan' || command === 'status') {
          const view = await inspect(ctx.cwd,{domain:arg});
          notify(ctx,view.jobs.map(j => `${j.domain}: ${j.status}${j.triggers.length ? ` (${j.triggers.map(t=>t.id).join(', ')})` : ''}`).join('\n'));
          return;
        }
        if (command === 'run' || command === 'force') {
          await ctx.waitForIdle();
          await sessionCapture(ctx);
          const result = await execute(ctx,{manual:true,force:command === 'force',domain:arg});
          notify(ctx,result.results.length ? result.results.map(r=>`${r.domain}: ${r.result}${r.error ? ` (${r.error})` : ''}`).join('\n') : 'No inspections are pending.');
          return;
        }
        throw new Error('Use /knowledge init, scan, run [domain], force [domain], auto off|scan|run, cancel, or unlock.');
      } catch (error) { notify(ctx,String(error.message ?? error),'error'); }
    }
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
      else if (ctx.hasUI) ctx.ui.setStatus('hindsight',`${result.pending.length} knowledge domains pending`);
    } catch (error) { notify(ctx,`Hindsight: ${error.message ?? error}`,'warning'); }
  });
  pi.on('before_agent_start',async (event,ctx) => {
    if (ctx.isProjectTrusted && !ctx.isProjectTrusted()) return;
    try {
      const root=await repositoryRoot(ctx.cwd);
      const {initialized}=await loadConfig(root);
      if (!initialized) return;
      const {catalog}=await loadRegistry(root);
      return {systemPrompt:`${event.systemPrompt}\n\n${hindsightIndex(catalog)}`};
    } catch { /* A non-Git workspace remains usable; /knowledge reports its actionable error. */ }
  });
  pi.on('session_shutdown',async () => { active?.abort(); });
}
