/**
 * Automatic Muse pull for `/hindsight run`. Pi is the hook: the run path
 * discovers Muse sessions for the repo, imports records new since the last
 * pull, and persists them with `source: 'muse'`. Orchestration only;
 * parsing lives in muse-adapter.mjs, storage in collector.mjs.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseMuseRecords, museSessionId, museWorkspaceRoot, museToPiEntries } from './muse-adapter.mjs';
import { captureMuseSession, repositoryRoot } from './collector.mjs';
import { readJson, writeJson } from './util.mjs';

export const MUSE_CURSORS_PATH = '.agents/curation/muse-cursors.json';

export function museStoreRoot() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
  return join(base, 'muse', 'sessions');
}

/** Candidate session.jsonl paths, excluding subagent subtrees. */
export async function discoverMuseSessions(storeRoot) {
  const found = [];
  const walk = async (dir) => {
    let dirents;
    try { dirents = await readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return; throw e; }
    for (const entry of dirents) {
      if (entry.name === 'subagent') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name === 'session.jsonl') found.push(full);
    }
  };
  await walk(storeRoot);
  return found.sort();
}

export async function loadMuseCursors(root) {
  return (await readJson(root, MUSE_CURSORS_PATH, {})) ?? {};
}

function maxSequence(records) {
  let max = -1;
  for (const r of records) if (Number.isSafeInteger(r?.sequence) && r.sequence > max) max = r.sequence;
  return max;
}

function entryChars(entries) {
  let n = 0;
  for (const e of entries) n += Buffer.byteLength(JSON.stringify(e));
  return n;
}

/**
 * Pull new Muse records for the repo at `root`. Mtime/size cursors skip
 * unchanged files; per-session sequence cursors skip imported records.
 * Files are processed oldest-first; the char budget defers whole files so
 * the next run resumes where this one stopped. Never throws for store
 * problems: a missing dir yields zeros, per-file failures skip the file.
 */
export async function importMuseSessions(root, config, { storeRoot = museStoreRoot() } = {}) {
  const budget = config?.maxMuseImportChars ?? 500000;
  const files = await discoverMuseSessions(storeRoot);
  const cursors = await loadMuseCursors(root);
  const repoCache = new Map();
  let sessions = 0, newRecords = 0, chars = 0, dirty = false;

  const matchesRepo = async (workspace) => {
    if (typeof workspace !== 'string' || !workspace) return false;
    if (repoCache.has(workspace)) return repoCache.get(workspace);
    let match = false;
    try { match = workspace === root || await repositoryRoot(workspace) === root; }
    catch { match = false; }
    repoCache.set(workspace, match);
    return match;
  };

  for (const file of files) {
    let st;
    try { st = await stat(file); }
    catch { continue; }
    const dirId = basename(dirname(file));
    const cursor = cursors[dirId];
    if (cursor && cursor.mtimeMs === st.mtimeMs && cursor.size === st.size) continue;
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch { continue; }
    let records;
    try {
      records = parseMuseRecords(text);
      const sessionId = museSessionId(records);
      if (!(await matchesRepo(museWorkspaceRoot(records)))) {
        cursors[dirId] = { maxSequence: maxSequence(records), path: file, mtimeMs: st.mtimeMs, size: st.size };
        dirty = true;
        continue;
      }
      const entries = museToPiEntries(records, { minSequence: cursor?.maxSequence ?? -1 });
      if (!entries.length) {
        cursors[dirId] = { maxSequence: maxSequence(records), path: file, mtimeMs: st.mtimeMs, size: st.size };
        dirty = true;
        continue;
      }
      const cost = entryChars(entries);
      if (chars > 0 && chars + cost > budget) break;
      await captureMuseSession(root, sessionId, entries);
      sessions += 1;
      newRecords += entries.length;
      chars += cost;
      cursors[dirId] = { maxSequence: maxSequence(records), path: file, mtimeMs: st.mtimeMs, size: st.size };
      dirty = true;
    } catch { continue; }
  }
  if (dirty) await writeJson(root, MUSE_CURSORS_PATH, cursors);
  return { sessions, newRecords };
}
