// Explicit live provider test. Uses the user's Pi authentication and incurs model usage.
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../src/collector.mjs';
import { setup,run,inspect } from '../src/engine.mjs';
import { readJson,writeJson } from '../src/util.mjs';

const provider=process.env.HINDSIGHT_LIVE_PROVIDER ?? process.env.PI_KNOWLEDGE_LIVE_PROVIDER,model=process.env.HINDSIGHT_LIVE_MODEL ?? process.env.PI_KNOWLEDGE_LIVE_MODEL;
assert(provider&&model,'Set HINDSIGHT_LIVE_PROVIDER and HINDSIGHT_LIVE_MODEL to a model authenticated in Pi.');
const base=fileURLToPath(new URL('../.test-work/',import.meta.url));await mkdir(base,{recursive:true});
const root=await mkdtemp(join(base,'live-'));
await git(root,['init','-q']);
await writeFile(join(root,'package.json'),JSON.stringify({name:'hindsight-live-fixture',private:true,version:'1.0.0',type:'module',engines:{node:'>=22.19.0'}}));
await setup(root);
const config=await readJson(root,'.agents/curation/config.json');await writeJson(root,'.agents/curation/config.json',{...config,provider,model});
console.log(`Live test reports and curated document: ${root}`);
const result=await run(root,{domain:'dependencies',onProgress:r=>console.log(r.domain,r.status??r.result)});
assert.ok(['updated','no_change'].includes(result.results[0]?.result),JSON.stringify(result.results));
assert.equal((await inspect(root,{domain:'dependencies'})).jobs[0].status,'unchanged');
console.log('Live Pi curator completed a manifest, committed a ledger/view transaction, and reached unchanged state. Review the memories and findings for semantic quality.');
