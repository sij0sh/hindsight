/**
 * Claude Code session adapter.
 *
 * Claude Code writes one JSONL transcript per session under
 * `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<encoded-cwd>/<sessionId>.jsonl`.
 * This module is pure: it projects the small keep-list (human-typed prompts,
 * assistant text, tool calls, tool outcomes) into the legacy Pi entry shape
 * consumed by `normalizePiSession`. Thinking, attachments, system lines,
 * compaction summaries, sidechains, slash-command and hook wrappers, and raw
 * tool bodies are dropped. Only human-typed prompts become user entries,
 * because user-role evidence can be promoted to authoritative memory.
 */
import { sanitizeUserText } from './session-normalizer.mjs';

/** Serialization policy version for Claude-derived evidence. */
export const CLAUDE_POLICY = 'claude-session-episode-v1';

// Transcripts written before `promptSource` existed: markers of slash commands,
// local shell turns, task notifications, interruptions, and continuation summaries.
const NON_HUMAN_MARKERS = [
  /<(command-(name|message|args)|local-command-[\w-]+|bash-(input|stdout|stderr)|task-notification)>/,
  /^\[Request interrupted/,
  /^This session is being continued/
];

// Default-deny arg projection: only listed tools keep listed fields. Bodies
// (old/new strings, file content, prompts, plans, answers) never survive;
// RAW_KEYS in session-normalizer.mjs is the second line of defense.
const pathOf = key => args => ({ path: args[key] });
const ARG_PROJECTION = {
  Read: pathOf('file_path'),
  Edit: pathOf('file_path'),
  Write: pathOf('file_path'),
  MultiEdit: pathOf('file_path'),
  NotebookEdit: pathOf('notebook_path'),
  Bash: args => ({ command: args.command }),
  Grep: args => ({ pattern: args.pattern, path: args.path }),
  Glob: args => ({ pattern: args.pattern, path: args.path }),
  WebFetch: args => ({ url: urlWithoutQuery(args.url) }),
  WebSearch: args => ({ query: args.query }),
  TodoWrite: args => ({ items: Array.isArray(args.todos) ? args.todos.length : 0 }),
  Agent: args => ({ subagent_type: args.subagent_type, description: args.description }),
  Task: args => ({ subagent_type: args.subagent_type, description: args.description }),
  Skill: args => ({ skill: args.skill })
};

function urlWithoutQuery(value) {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
  catch { return undefined; }
}

export function projectClaudeArgs(name, input) {
  const project = ARG_PROJECTION[name];
  if (!project || !input || typeof input !== 'object') return {};
  const projected = {};
  for (const [key, value] of Object.entries(project(input))) {
    if (typeof value === 'string' ? value.length > 0 : typeof value === 'number') projected[key] = value;
  }
  return projected;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
  return '';
}

/**
 * Reduce a `tool_result` block to a pre-digested outcome for
 * `summarizeToolResult`. Bash output is kept only so test counts can be
 * recognized; the raw `toolUseResult` is never passed through.
 */
export function digestClaudeResult(name, block, toolUseResult = null) {
  const failed = block?.is_error === true;
  if (name !== 'Bash') return failed ? { success: false } : {};
  if (toolUseResult && typeof toolUseResult === 'object' && toolUseResult.interrupted === true) return { outcome: 'interrupted' };
  if (failed) {
    const text = blockText(block.content);
    const exit = /Exit code (\d+)/.exec(text);
    return exit ? { exitCode: Number(exit[1]), output: text } : { success: false };
  }
  const output = typeof toolUseResult?.stdout === 'string' ? toolUseResult.stdout : blockText(block?.content);
  return { exitCode: 0, output };
}

/** True when parsed lines hold Claude Code transcript turns. Pi and Muse files yield false. */
export function isClaudeSession(lines) {
  return (lines ?? []).some(l => ['user', 'assistant'].includes(l?.type) && typeof l.uuid === 'string' && typeof l.sessionId === 'string' && l.message && typeof l.message === 'object');
}

function droppedLine(line) {
  return line.isSidechain === true || line.isMeta === true || line.isCompactSummary === true || line.isVisibleInTranscriptOnly === true ||
    line.isApiErrorMessage === true || line.message?.model === '<synthetic>';
}

function humanText(line, promptSourceKnown) {
  if (promptSourceKnown && line.promptSource !== 'typed') return '';
  if (line.origin?.kind !== undefined && line.origin.kind !== 'human') return '';
  const content = line.message?.content;
  const raw = typeof content === 'string' ? content : Array.isArray(content) && content.every(b => b?.type === 'text' || b?.type === 'image') ? blockText(content) : '';
  const trimmed = raw.trim();
  if (NON_HUMAN_MARKERS.some(pattern => pattern.test(trimmed))) return '';
  return sanitizeUserText(trimmed);
}

/**
 * Project parsed transcript lines into legacy Pi entries, grouped by each
 * line's own `sessionId` (resumed or forked files may mix identities).
 * Returns Map<sessionId, { cwd, entries }>.
 */
export function claudeToPiEntries(lines, { sessionId: fallbackId = null } = {}) {
  const turns = (lines ?? []).filter(l => l && typeof l === 'object' && ['user', 'assistant'].includes(l.type) && typeof l.uuid === 'string' && l.message && typeof l.message === 'object');
  // When any prompt carries promptSource, only 'typed' prompts are human; otherwise the marker blocklist applies.
  const promptSourceKnown = turns.some(l => l.type === 'user' && typeof l.promptSource === 'string');
  const toolNames = new Map();
  for (const line of turns) {
    if (line.type !== 'assistant' || !Array.isArray(line.message.content)) continue;
    for (const block of line.message.content) if (block?.type === 'tool_use' && typeof block.id === 'string') toolNames.set(block.id, block.name);
  }
  const sessions = new Map();
  for (const line of turns) {
    if (droppedLine(line)) continue;
    const sessionId = typeof line.sessionId === 'string' && line.sessionId ? line.sessionId : fallbackId;
    if (!sessionId) continue;
    if (!sessions.has(sessionId)) sessions.set(sessionId, { cwd: null, entries: [] });
    const session = sessions.get(sessionId);
    if (!session.cwd && typeof line.cwd === 'string' && line.cwd) session.cwd = line.cwd;
    const timestamp = typeof line.timestamp === 'string' ? line.timestamp : '';
    const content = line.message.content;
    if (line.type === 'user') {
      const results = Array.isArray(content) ? content.filter(b => b?.type === 'tool_result') : [];
      if (results.length) {
        // Tool results arrive as user-role lines but are never human input.
        content.forEach((block, index) => {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return;
          const toolUseResult = results.length === 1 ? line.toolUseResult : null;
          session.entries.push({ type: 'tool_result', id: `${line.uuid}:${index}`, timestamp, toolCallId: block.tool_use_id, result: digestClaudeResult(toolNames.get(block.tool_use_id), block, toolUseResult) });
        });
        continue;
      }
      const text = humanText(line, promptSourceKnown);
      if (text) session.entries.push({ type: 'message', id: line.uuid, timestamp, message: { role: 'user', content: text } });
      continue;
    }
    const blocks = Array.isArray(content) ? content : [];
    const text = typeof content === 'string' ? content.trim() : blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
    if (text) session.entries.push({ type: 'message', id: line.uuid, timestamp, message: { role: 'assistant', content: text } });
    for (const block of blocks) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
      session.entries.push({ type: 'tool_call', id: block.id, timestamp, name: typeof block.name === 'string' ? block.name : 'tool', input: projectClaudeArgs(block.name, block.input) });
    }
  }
  return sessions;
}
