import { readFile } from 'node:fs/promises';
import { assert, hash, readJson, validRelative, writeJson } from './util.mjs';

export const CONFIG_PATH = '.agents/curation/config.json';
export const STATE_PATH = '.agents/curation/state.json';
export const DEFAULTS = {
  version: 1,
  auto: 'run',
  maxAutoJobs: 3,
  candidateDelayEvents: 3,
  retryDelayEvents: 3,
  maxTurns: 90,
  timeoutMs: 1800000,
  maxDerivedChecks: 16,
  maxFileBytes: 500000,
  maxSnapshotBytes: 30000000,
  maxFiles: 20000,
  maxReadChars: 18000,
  maxCoverageBundleChars: 600000,
  maxCoverageBundleParts: 8,
  maxGitHistoryCommits: 100,
  maxGitPatchChars: 60000,
  maxDocumentChars: 40000,
  maxSessionBatchChars: 80000,
  historyWindow: 30,
  churnThreshold: 10,
  maxRecords: 2000,
  maxMemoryStatementChars: 1200,
  maxLedgerBytes: 8000000,
  maxContextChars: 12000,
  museAutoImport: true,
  maxMuseImportChars: 500000,
  contextInjection: false,
  exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/vendor/**', '**/*.snap', '**/*.min.js'],
  sensitive: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/credentials.json', '**/auth.json'],
  sensitiveAllow: ['**/.env.example', '**/.env.sample', '**/.env.template'],
  provider: 'azure-gateway-responses',
  model: 'gpt-6-luna'
};

export async function loadConfig(root) {
  const user = await readJson(root, CONFIG_PATH);
  // Explicit nulls in a stored config mean unset; DEFAULTS stays the source of truth for them.
  const config = { ...DEFAULTS, ...Object.fromEntries(Object.entries(user ?? {}).filter(([, value]) => value !== null)) };
  for (const key of Object.keys(config)) assert(key in DEFAULTS, `Unknown configuration key: ${key}`);
  assert(config.version === 1, 'Unsupported config version');
  assert(['off', 'scan', 'run'].includes(config.auto), 'auto must be off, scan, or run');
  assert(typeof config.contextInjection==='boolean','contextInjection must be boolean');
  assert(typeof config.museAutoImport==='boolean','museAutoImport must be boolean');
  for (const key of ['maxAutoJobs','candidateDelayEvents','retryDelayEvents','maxTurns','timeoutMs','maxDerivedChecks','maxFileBytes','maxSnapshotBytes','maxFiles','maxReadChars','maxCoverageBundleChars','maxCoverageBundleParts','maxGitHistoryCommits','maxGitPatchChars','maxDocumentChars','maxSessionBatchChars','historyWindow','churnThreshold','maxRecords','maxMemoryStatementChars','maxLedgerBytes','maxContextChars','maxMuseImportChars']) {
    assert(Number.isSafeInteger(config[key]) && config[key] > 0, `Invalid positive integer: ${key}`);
  }
  for (const key of ['exclude','sensitive','sensitiveAllow']) assert(Array.isArray(config[key]) && config[key].every(p => typeof p === 'string' && p.length > 0), `Invalid pattern list: ${key}`);
  assert((config.model === null && config.provider === null) || (typeof config.model === 'string' && typeof config.provider === 'string'), 'Set provider and model together');
  return { config, initialized: user !== null };
}
export async function loadRegistry(root) {
  const catalog = await readJson(root, '.agents/curation/registry.json') ?? JSON.parse(await readFile(new URL('../catalog/registry.json', import.meta.url), 'utf8'));
  validateRegistry(catalog);
  return { catalog, fingerprint: hash(catalog) };
}
export function validateRegistry(catalog) {
  assert(catalog.version === 1 && Array.isArray(catalog.documents) && catalog.documents.length === 10, 'Registry must define the ten engineering domains');
  const known = new Set(['intent_and_contracts','architecture','code_standards','testing','security','dependencies','delivery','operations','maintainability','agent_policy']);
  const domains = new Set(), paths = new Set(), checkIds = new Set();
  for (const doc of catalog.documents) {
    assert(known.has(doc.id) && !domains.has(doc.id), 'Invalid/duplicate domain'); domains.add(doc.id);
    validRelative(doc.path);
    assert(doc.path === `.agents/engineering/${doc.id.toUpperCase()}.md` && !paths.has(doc.path), 'Invalid/duplicate document path'); paths.add(doc.path);
    assert(Number.isSafeInteger(doc.version) && doc.version > 0, 'Invalid criterion version');
    assert(Array.isArray(doc.inputPaths) && doc.inputPaths.every(p=>typeof p==='string'&&p.length>0) && Array.isArray(doc.criteria) && doc.criteria.length > 0, 'Missing domain input surface or criteria');
    assert(Array.isArray(doc.rules) && Array.isArray(doc.baseline), 'Missing domain rules or baseline');
    for (const check of doc.criteria) { assert(typeof check.id === 'string' && !checkIds.has(check.id) && typeof check.question === 'string', 'Duplicate/invalid criterion'); checkIds.add(check.id); }
    const ids = new Set(doc.criteria.map(c => c.id));
    for (const id of doc.baseline) assert(ids.has(id), `Unknown baseline criterion ${id}`);
    for (const rule of doc.rules) {
      assert(typeof rule.id === 'string' && ['affected','candidate'].includes(rule.level), 'Invalid routing rule');
      assert(Array.isArray(rule.paths) && Array.isArray(rule.checks) && rule.checks.every(id => ids.has(id)), `Invalid trigger mapping ${rule.id}`);
      assert(rule.paths.every(p=>typeof p==='string'&&p.length>0) && (!rule.signal || ['session','imports','execution','security','maintenance','churn'].includes(rule.signal)), `Invalid detector ${rule.id}`);
    }
  }
  assert(Array.isArray(catalog.common) && catalog.common.length > 0, 'Missing common criteria');
  for (const check of catalog.common) { assert(typeof check.id==='string' && typeof check.question==='string' && !checkIds.has(check.id), 'Duplicate/invalid common criterion'); checkIds.add(check.id); }
}
export async function initialize(root) {
  const { initialized } = await loadConfig(root);
  if (!initialized) await writeJson(root, CONFIG_PATH, DEFAULTS);
  if (!(await readJson(root, '.agents/curation/registry.json'))) {
    const { catalog } = await loadRegistry(root);
    await writeJson(root, '.agents/curation/registry.json', catalog);
  }
}
