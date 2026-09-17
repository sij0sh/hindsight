// Requires npm install. Verifies the actual published SDK without spending model tokens.
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createIsolatedSession } from '../src/pi-sdk.mjs';
import { Investigation } from '../src/investigation.mjs';
import { DEFAULTS } from '../src/config.mjs';

const base=fileURLToPath(new URL('../.test-work/',import.meta.url));await mkdir(base,{recursive:true});
const root=await mkdtemp(join(base,'sdk-'));
try {
  const settingsManager=sdk.SettingsManager.inMemory({});
  const loader=new sdk.DefaultResourceLoader({cwd:root,agentDir:root,settingsManager,additionalExtensionPaths:[fileURLToPath(new URL('../extension.ts',import.meta.url))]});
  await loader.reload();
  const loaded=loader.getExtensions();
  assert.deepEqual(loaded.errors,[]);
  assert.equal(loaded.extensions.length,1,'Pi must discover the actual extension');
  const inv=new Investigation({domain:'dependencies',checks:[],changedFiles:[],sessionBatch:[]},{contents:new Map(),documents:{dependencies:{content:null}},files:{},churn:{}},DEFAULTS);
  const modelRuntime=await sdk.ModelRuntime.create({signal:AbortSignal.timeout(15000)});
  const {session,cleanup}=await createIsolatedSession(sdk,inv,{modelRuntime});
  assert.equal(session.agent.state.tools.length,5);
  await cleanup();
  console.log('Published Pi SDK loads the extension and isolates curator tools successfully. No model call was made.');
} finally {await rm(root,{recursive:true,force:true});}
