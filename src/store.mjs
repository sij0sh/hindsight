import { open, mkdir, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { assert, safePath, readJson, writeJson, optionalRead, hash, atomicWrite } from './util.mjs';
import { STATE_PATH } from './config.mjs';

const LOCK = '.agents/curation/run.lock';
const JOURNAL = '.agents/curation/transaction.json';
export const emptyState = () => ({ version:1, documents:{}, queue:{}, tick:0 });
export async function loadState(root) {
  const state = await readJson(root, STATE_PATH, emptyState());
  assert(state.version === 1 && state.documents && typeof state.documents === 'object' && !Array.isArray(state.documents), 'Unsupported or corrupt curation state');
  assert(state.queue && typeof state.queue==='object' && !Array.isArray(state.queue) && Number.isSafeInteger(state.tick) && state.tick>=0,'Corrupt queue state');
  for (const [id, doc] of Object.entries(state.documents)) {
    assert(doc.files && typeof doc.files==='object' && !Array.isArray(doc.files) && doc.sessions && typeof doc.sessions==='object' && !Array.isArray(doc.sessions) && typeof doc.inputFingerprint === 'string' && typeof doc.documentFingerprint === 'string' && typeof doc.ruleFingerprint==='string', `Corrupt domain state: ${id}`);
    assert(Object.values(doc.files).every(f=>f&&typeof f.hash==='string') && Object.values(doc.sessions).every(s=>typeof s==='string'),`Corrupt source inventory: ${id}`);
    if (doc.sessionEpisodes === undefined) doc.sessionEpisodes = {};
    assert(doc.sessionEpisodes && typeof doc.sessionEpisodes==='object' && !Array.isArray(doc.sessionEpisodes) && Object.values(doc.sessionEpisodes).every(s=>typeof s==='string'),`Corrupt episode inventory: ${id}`);
  }
  return state;
}
export function isLocalDeadOwner(owner) {
  if (!owner || owner.host !== hostname()) return false;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  if (typeof owner.startedAt !== 'string' || Number.isNaN(Date.parse(owner.startedAt))) return false;
  try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') return true; if (e.code === 'EPERM') return false; throw e; }
  return false;
}
export function describeOwner(owner) {
  const pid = owner?.pid ?? 'unknown';
  const host = owner?.host ?? 'unknown';
  const startedAt = owner?.startedAt ?? 'unknown';
  let age = 'unknown';
  if (typeof owner?.startedAt === 'string') {
    const ms = Date.now() - Date.parse(owner.startedAt);
    if (!Number.isNaN(ms)) age = `${Math.max(0, Math.floor(ms / 1000))}s`;
  }
  return `pid ${pid}, host ${host}, startedAt ${startedAt}, age ${age}`;
}
function lockHeldMessage(owner) {
  if (owner && typeof owner.host === 'string' && owner.host !== hostname()) return `Lock owner is on host ${owner.host}; inspect that host before manual action.`;
  return `A curation run holds run.lock (${describeOwner(owner)}). If the process crashed, retry; the next run purges a dead local lock automatically.`;
}
export async function withLock(root, fn) {
  const path = await safePath(root, LOCK);
  await mkdir(dirname(path), { recursive:true });
  let fd;
  try { fd = await open(path,'wx',0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = await readLockOwner(root);
    if (isLocalDeadOwner(owner)) {
      await unlink(path).catch(err => { if (err.code !== 'ENOENT') throw err; });
      try { fd = await open(path,'wx',0o600); }
      catch (e2) {
        if (e2.code === 'EEXIST') throw new Error(lockHeldMessage(await readLockOwner(root)));
        throw e2;
      }
    } else {
      throw new Error(lockHeldMessage(owner));
    }
  }
  const token = randomUUID();
  try {
    await fd.writeFile(JSON.stringify({ pid:process.pid, host:hostname(), token, startedAt:new Date().toISOString() }));
    await fd.close(); fd = null;
    await recover(root);
    return await fn();
  } finally {
    if (fd) await fd.close();
    const owner = await readJson(root, LOCK);
    if (owner?.token === token) await unlink(path);
  }
}
export async function readLockOwner(root) {
  return readJson(root, LOCK, null);
}
export function lockOwnerAlive(owner) {
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
  if (typeof owner.startedAt !== 'string' || Number.isNaN(Date.parse(owner.startedAt))) return null;
  try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; if (e.code === 'EPERM') return true; throw e; }
  return true;
}
export async function unlock(root) {
  const owner = await readJson(root, LOCK);
  if (!owner) return 'No lock exists.';
  if (typeof owner.host === 'string' && owner.host !== hostname()) throw new Error(`Lock owner is on host ${owner.host}; inspect that host before manual action.`);
  assert(owner.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.startedAt === 'string' && !Number.isNaN(Date.parse(owner.startedAt)), 'Cannot establish that this lock owner is local and stopped');
  if (isLocalDeadOwner(owner)) {
    await unlink(await safePath(root, LOCK));
    return 'Removed the stopped process lock. The next run will recover any pending transaction.';
  }
  throw new Error(lockHeldMessage(owner));
}
export async function commit(root, path, previousContent, nextContent, nextState, reportPath) {
  const current = await optionalRead(await safePath(root,path));
  assert(current === previousContent, 'Canonical document changed during investigation; retry without overwriting it');
  const stateText = await optionalRead(await safePath(root,STATE_PATH));
  const transaction = {
    version:1, path, expectedDocumentHash:current === null ? null : hash(current), nextContent,
    expectedStateHash:stateText === null ? null : hash(stateText), nextState, reportPath
  };
  await writeJson(root,JOURNAL,transaction);
  await recover(root);
}
export async function recover(root) {
  const tx = await readJson(root,JOURNAL);
  if (!tx) return;
  if(tx.version===2) return recoverBatch(root,tx);
  assert(tx.version === 1 && typeof tx.path === 'string' && /^\.agents\/engineering\/[A-Z_]+\.md$/.test(tx.path) && typeof tx.nextContent === 'string' && tx.nextState?.version === 1, 'Invalid transaction journal');
  const doc = await optionalRead(await safePath(root,tx.path));
  const documentHash = doc === null ? null : hash(doc);
  assert(documentHash === tx.expectedDocumentHash || documentHash === hash(tx.nextContent), 'Recovery stopped: canonical document was manually edited after interruption');
  const stateText = await optionalRead(await safePath(root,STATE_PATH));
  const stateHash = stateText === null ? null : hash(stateText);
  const nextStateText = `${JSON.stringify(tx.nextState,null,2)}\n`;
  assert(stateHash === tx.expectedStateHash || stateHash === hash(nextStateText), 'Recovery stopped: state changed after interruption');
  if (documentHash !== hash(tx.nextContent)) await atomicWrite(root,tx.path,tx.nextContent);
  await atomicWrite(root,STATE_PATH,nextStateText);
  await writeJson(root,'.agents/curation/last-commit.json',{ document:tx.path, reportPath:tx.reportPath, documentFingerprint:hash(tx.nextContent), committedAt:new Date().toISOString() });
  await unlink(await safePath(root,JOURNAL));
}

const allowedTransactionPath=p=>p==='AGENTS.md'||p==='.agents/curation/memory.json'||p===STATE_PATH||/^\.agents\/engineering\/[A-Z_]+\.md$/.test(p)||/^\.agents\/curation\/migration\/[a-f0-9]{64}\.md$/.test(p);
export async function commitBatch(root,entries,reportPath) {
  assert(entries.length>0&&entries.length<=100,'Invalid transaction size');
  const paths=new Set();
  for(const e of entries) {
    assert(allowedTransactionPath(e.path)&&!paths.has(e.path),'Invalid/duplicate transaction target');paths.add(e.path);
    assert(typeof e.nextContent==='string'&&(e.previousContent===null||typeof e.previousContent==='string'),'Invalid transaction contents');
    assert(await optionalRead(await safePath(root,e.path))===e.previousContent,`Transaction precondition changed: ${e.path}`);
  }
  const tx={version:2,reportPath,entries:entries.map(e=>({path:e.path,expectedHash:e.previousContent===null?null:hash(e.previousContent),nextContent:e.nextContent}))};
  await writeJson(root,JOURNAL,tx);
  await recoverBatch(root,tx);
}
async function recoverBatch(root,tx) {
  assert(Array.isArray(tx.entries)&&tx.entries.length>0&&tx.entries.length<=100,'Invalid transaction journal');
  const seen=new Set(),pending=[];
  // Preflight EVERY target before replaying ANY write. Later conflicts cannot partially replay earlier targets.
  for(const entry of tx.entries) {
    assert(allowedTransactionPath(entry.path)&&!seen.has(entry.path)&&typeof entry.nextContent==='string','Invalid transaction journal target');seen.add(entry.path);
    const current=await optionalRead(await safePath(root,entry.path)),currentHash=current===null?null:hash(current);
    assert(currentHash===entry.expectedHash||currentHash===hash(entry.nextContent),`Recovery stopped: external edit in ${entry.path}`);
    if(currentHash!==hash(entry.nextContent))pending.push(entry);
  }
  for(const e of pending)await atomicWrite(root,e.path,e.nextContent);
  await writeJson(root,'.agents/curation/last-commit.json',{reportPath:tx.reportPath,paths:tx.entries.map(e=>e.path),committedAt:new Date().toISOString()});
  await unlink(await safePath(root,JOURNAL));
}
