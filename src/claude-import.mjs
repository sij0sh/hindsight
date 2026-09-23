/**
 * On-disk Claude Code pull for `/hindsight run` and `hindsight import`.
 * Reads only top-level `<sessionId>.jsonl` transcripts; the per-session
 * `subagents/` and `tool-results/` subtrees are never entered. Parsing lives
 * in claude-adapter.mjs, storage in collector.mjs.
 */
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { captureClaudeSession } from './collector.mjs';
import { claudeToPiEntries } from './claude-adapter.mjs';
import { importJsonlSessions } from './session-import.mjs';

// Claude truncates long encoded project names; compare on the untruncated prefix.
const ENCODED_PREFIX_CHARS = 200;

export function claudeProjectsDir() {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

/** Claude's project directory name: every non-alphanumeric character becomes a dash. */
export function claudeProjectDirName(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Candidate Claude transcripts for `root`: the repository's own project
 * directory and subdirectory cwds. Encoding collisions are possible, so the
 * per-line cwd remains the authoritative gate.
 */
export async function discoverClaudeSessions(root) {
  const projects = claudeProjectsDir();
  const exact = claudeProjectDirName(root).slice(0, ENCODED_PREFIX_CHARS);
  let dirents = [];
  try { dirents = await readdir(projects, { withFileTypes: true }); }
  catch (e) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(e.code)) throw e; }
  const found = [];
  for (const d of dirents) {
    if (!d.isDirectory() || !(d.name === exact || d.name.startsWith(`${exact}-`))) continue;
    let files = [];
    try { files = await readdir(join(projects, d.name), { withFileTypes: true }); }
    catch (e) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(e.code)) throw e; }
    for (const f of files) if (f.isFile() && f.name.endsWith('.jsonl')) found.push(join(projects, d.name, f.name));
  }
  return found.sort();
}

export function adaptClaudeLines(lines, file) {
  const sessions = claudeToPiEntries(lines, { sessionId: basename(file ?? '', '.jsonl') || null });
  return [...sessions].map(([sessionId, { cwd, entries }]) => ({ sessionId, cwd, entries }));
}

export async function importClaudeSessions(root, config) {
  return importJsonlSessions(root, config, {
    source: 'claude',
    files: await discoverClaudeSessions(root),
    adapt: adaptClaudeLines,
    capture: captureClaudeSession,
    budget: config.maxClaudeImportChars
  });
}
