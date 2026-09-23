/**
 * Shared on-disk pull for JSONL session stores (Pi, Claude Code). Muse keeps
 * its sequence-cursor importer in muse-import.mjs. Orchestration only:
 * source modules discover files and adapt parsed lines; storage lives in
 * collector.mjs.
 *
 * Like the Muse pull, store problems never throw: a missing store yields
 * zeros and an unreadable or unparseable file is skipped (and retried on the
 * next run). This is deliberate so a foreign, user-owned transcript can never
 * block curation. Repository writes (archives, cursors) still fail loud.
 */
import { readFile, stat } from 'node:fs/promises';
import { repositoryRoot, sessionArchiveChars } from './collector.mjs';
import { hash, readJson, writeJson } from './util.mjs';

export const SESSION_CURSORS_PATH = '.agents/curation/session-cursors.json';
// Transcripts far above any real session are skipped rather than read into memory.
const OVERSIZED_FACTOR = 400;

/** Parse JSONL, dropping blank and unparseable lines (a live file may end mid-line). */
export function parseJsonLines(text) {
  const lines = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object' && !Array.isArray(value)) lines.push(value);
    } catch { /* partial or corrupt line */ }
  }
  return lines;
}

/** Cached cwd → "belongs to this repository" check; subdirectories of the repository match. */
export function repositoryMatcher(root) {
  const cache = new Map();
  return async cwd => {
    if (typeof cwd !== 'string' || !cwd) return false;
    if (!cache.has(cwd)) cache.set(cwd, cwd === root || await repositoryRoot(cwd).then(found => found === root, () => false));
    return cache.get(cwd);
  };
}

/**
 * Import changed JSONL transcripts for the repository at `root`.
 * `adapt(lines, file)` returns `[{ sessionId, cwd, entries }]`; `capture`
 * stores one session and returns `{ added, changed, chars }`. Changed files are
 * re-adapted whole (merging by stable id is idempotent), oldest first. The
 * first captured file always completes; later files wait once `budget` new
 * chars are charged or the archive nears `maxSnapshotBytes`.
 */
export async function importJsonlSessions(root, config, { source, files, adapt, capture, budget }) {
  const cursors = (await readJson(root, SESSION_CURSORS_PATH, {})) ?? {};
  const matches = repositoryMatcher(root);
  const snapshotLimit = 0.9 * config.maxSnapshotBytes;
  let archiveChars = null, sessions = 0, newEvents = 0, chars = 0, oversized = 0, deferred = null, dirty = false;
  const candidates = [];
  for (const file of files) {
    try { candidates.push({ file, st: await stat(file) }); }
    catch { /* vanished between discovery and stat */ }
  }
  candidates.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs || (a.file < b.file ? -1 : 1));
  for (const { file, st } of candidates) {
    // Cursor keys are hashed so absolute home paths never land in .agents.
    const key = `${source}:${hash(file).slice(7)}`;
    const cursor = cursors[key];
    if (cursor && cursor.mtimeMs === st.mtimeMs && cursor.size === st.size) continue;
    if (st.size > config.maxFileBytes * OVERSIZED_FACTOR) { oversized += 1; continue; }
    if (chars >= budget) { deferred = 'budget'; break; }
    archiveChars ??= await sessionArchiveChars(root);
    if (2 * (archiveChars + chars) > snapshotLimit) { deferred = 'maxSnapshotBytes'; break; }
    let adapted;
    try { adapted = adapt(parseJsonLines(await readFile(file, 'utf8')), file); }
    catch { continue; }
    const sessionIds = [];
    for (const session of adapted) {
      if (!(await matches(session.cwd))) continue;
      sessionIds.push(session.sessionId);
      if (!session.entries.length) continue;
      const result = await capture(root, session.sessionId, session.entries);
      if (result.added || result.changed) sessions += 1;
      newEvents += result.added + result.changed;
      chars += result.chars;
    }
    cursors[key] = { sessionIds, mtimeMs: st.mtimeMs, size: st.size };
    dirty = true;
  }
  if (dirty) await writeJson(root, SESSION_CURSORS_PATH, cursors);
  return { sessions, newEvents, deferred, oversized };
}
