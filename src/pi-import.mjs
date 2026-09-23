/**
 * On-disk Pi pull for `/hindsight run` and `hindsight import`. The live
 * extension hook captures the active branch; this pull recovers sessions the
 * hook missed (lock held, extension not loaded) and later tool results. Both
 * paths produce identical atomic ids, so merging is idempotent.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { captureSession } from './collector.mjs';
import { importJsonlSessions } from './session-import.mjs';

// Delegated subagent sessions open with the task file as their only prompt.
const SUBAGENT_TASK = /^\s*<file name="[^"]*pi-subagent-[^"]*[\\/]task\.md">/;

const expandHome = path => path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

export function piAgentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured ? expandHome(configured) : join(homedir(), '.pi', 'agent');
}

/** Pi's per-cwd session directory name: `--<cwd with separators as dashes>--`. */
export function piSessionDirName(cwd) {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

async function jsonlFiles(dir) {
  try { return (await readdir(dir, { withFileTypes: true })).filter(d => d.isFile() && d.name.endsWith('.jsonl')).map(d => join(dir, d.name)); }
  catch (e) { if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(e.code)) return []; throw e; }
}

/**
 * Candidate Pi transcripts for `root`: the repository's own directory and
 * subdirectory cwds (`--<root>-...--`). The header cwd is the authoritative
 * gate; this prefix only avoids reading unrelated projects.
 */
export async function discoverPiSessions(root) {
  const override = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (override) return (await jsonlFiles(expandHome(override))).sort();
  const sessionsDir = join(piAgentDir(), 'sessions');
  const exact = piSessionDirName(root);
  const nested = exact.slice(0, -2) + '-';
  let dirents = [];
  try { dirents = await readdir(sessionsDir, { withFileTypes: true }); }
  catch (e) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(e.code)) throw e; }
  const found = [];
  for (const d of dirents) {
    if (d.isDirectory() && (d.name === exact || d.name.startsWith(nested))) found.push(...await jsonlFiles(join(sessionsDir, d.name)));
  }
  return found.sort();
}

/** Forks copy parent entries (with their original ids) ahead of the new header; keep only this session's own entries. */
export function dropInheritedEntries(header, entries) {
  if (!header?.parentSession || typeof header.timestamp !== 'string') return entries;
  return entries.filter(e => typeof e?.timestamp !== 'string' || e.timestamp >= header.timestamp);
}

function firstUserText(entries) {
  const first = entries.find(e => e?.type === 'message' && e.message?.role === 'user');
  const content = first?.message?.content;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text).join('\n') : '';
}

export function adaptPiLines(lines) {
  const header = lines.find(l => l.type === 'session');
  if (!header || typeof header.id !== 'string' || !header.id) return [];
  const entries = dropInheritedEntries(header, lines.filter(l => l !== header));
  if (SUBAGENT_TASK.test(firstUserText(entries))) return [];
  return [{ sessionId: header.id, cwd: header.cwd, entries }];
}

export async function importPiSessions(root, config) {
  return importJsonlSessions(root, config, {
    source: 'pi',
    files: await discoverPiSessions(root),
    adapt: adaptPiLines,
    capture: (repo, sessionId, entries) => captureSession(repo, sessionId, entries, { source: 'pi' }),
    budget: config.maxPiImportChars
  });
}
