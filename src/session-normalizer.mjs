import { hash } from './util.mjs';

/** Serialization policy version. Included in content hashes so a policy change re-pends evidence. */
export const SESSION_POLICY = 'pi-session-episode-v1';

const MAX_COMMAND_CHARS = 300;
const MAX_ARG_SUMMARY_CHARS = 500;
// Raw payload keys are never indexed: sessions must not become a second copy of source files or secrets.
const RAW_KEYS = new Set(['output', 'stdout', 'stderr', 'result', 'content', 'data', 'payload', 'filecontent', 'file_content', 'text', 'body', 'response', 'find', 'replace', 'todos']);

export function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c?.type === 'text').map(c => c.text).join('\n');
  return '';
}

function isToolCallBlock(block) {
  if (!block || typeof block !== 'object' || typeof block.type !== 'string') return false;
  const type = block.type.toLowerCase();
  return type.includes('tool') && !type.includes('result') && !type.includes('response');
}

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function looksLikePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && !value.includes('\0') && !/[\r\n]/.test(value) && /^[\w@.~][\w@.\-+/]*$/.test(value);
}

function pathFromArgs(args) {
  if (!args || typeof args !== 'object') {
    if (looksLikePath(args)) return args;
    return null;
  }
  for (const key of ['path', 'file', 'filename', 'filePath', 'target', 'filepath']) {
    if (looksLikePath(args[key])) return args[key];
  }
  for (const value of Object.values(args)) {
    if (Array.isArray(value)) {
      const paths = value.filter(looksLikePath);
      if (paths.length === 1) return paths[0];
    }
  }
  if (typeof args.command !== 'string') {
    const positional = firstString(args[0], args._);
    if (looksLikePath(positional)) return positional;
  }
  return null;
}

function bound(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

function safeArgSummary(args) {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return bound(args.trim().split('\n')[0], MAX_ARG_SUMMARY_CHARS);
  if (typeof args !== 'object') return bound(String(args), MAX_ARG_SUMMARY_CHARS);
  const safe = {};
  for (const [key, value] of Object.entries(args)) {
    if (RAW_KEYS.has(key.toLowerCase())) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
    else if (Array.isArray(value) && value.every(v => v === null || ['string', 'number', 'boolean'].includes(typeof v))) safe[key] = value.slice(0, 8);
  }
  const rendered = JSON.stringify(safe);
  return rendered === '{}' ? '' : bound(rendered, MAX_ARG_SUMMARY_CHARS);
}

/**
 * Reduce a tool call to a compact summary plus touched repository paths.
 * Raw file contents and shell output are deliberately discarded.
 */
export function summarizeToolCall(name, args) {
  const normalized = String(name ?? 'tool').trim() || 'tool';
  const kind = normalized.toLowerCase();
  if (['read', 'cat', 'show', 'open', 'get', 'view', 'read_file'].includes(kind)) {
    const path = pathFromArgs(args);
    return { summary: path ? `${normalized} ${path}` : normalized, paths: path ? [path] : [] };
  }
  if (['edit', 'write', 'create', 'apply_patch', 'patch', 'update', 'apply', 'edit_file', 'write_file'].includes(kind)) {
    const path = pathFromArgs(args);
    return { summary: path ? `${normalized} ${path}` : normalized, paths: path ? [path] : [] };
  }
  if (['bash', 'exec', 'shell', 'command', 'run', 'terminal'].includes(kind)) {
    const command = typeof args === 'string' ? args : firstString(args?.command, args?.cmd, args?.script, Array.isArray(args?.args) ? args.args.join(' ') : null);
    const firstLine = bound((command ?? '').trim().split('\n')[0] ?? '', MAX_COMMAND_CHARS);
    return { summary: firstLine ? `${normalized} ${firstLine}` : normalized, paths: [] };
  }
  if (['search', 'grep'].includes(kind)) {
    const pattern = typeof args?.pattern === 'string' && args.pattern.trim() ? args.pattern.trim().split('\n')[0].slice(0, 200) : '';
    const paths = Array.isArray(args?.paths) ? args.paths.filter(looksLikePath).slice(0, 8) : [];
    const summary = [normalized, pattern, paths.length ? `in ${paths.join(', ')}` : ''].filter(Boolean).join(' ');
    return { summary, paths: [] };
  }
  const detail = safeArgSummary(args);
  return { summary: detail ? `${normalized} ${detail}` : normalized, paths: [] };
}

function findCounts(haystack) {
  const counts = [];
  for (const match of haystack.matchAll(/(\d{1,7})\s+(tests?\b|passed\b|failed\b|errors?\b)/gi)) counts.push(`${match[1]} ${match[2].toLowerCase()}`);
  return [...new Set(counts)].slice(0, 4);
}

/**
 * Reduce a structured tool result to exit status, duration, and recognized
 * test counts. Raw stdout/stderr bodies never enter the summary.
 */
export function summarizeToolResult(name, result) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') {
    const counts = findCounts(result);
    return counts.length ? `completed (${counts.join(', ')})` : null;
  }
  if (typeof result !== 'object') return null;
  const parts = [];
  const exit = result.exitCode ?? result.exit_code ?? result.code ?? result.status;
  if (Number.isSafeInteger(exit)) parts.push(`exit ${exit}`);
  else if (typeof exit === 'string' && /^(success|fail|error|ok)$/i.test(exit.trim())) parts.push(exit.trim().toLowerCase());
  const duration = result.durationMs ?? result.duration_ms ?? result.duration;
  if (typeof duration === 'number' && Number.isFinite(duration)) parts.push(`${Math.round(duration)}ms`);
  const counts = findCounts(JSON.stringify(result));
  if (counts.length) parts.push(counts.join(', '));
  if (!parts.length) {
    if (result.success === true) parts.push('success');
    else if (result.success === false) parts.push('failed');
    else if (typeof result.outcome === 'string' && result.outcome.length <= 60) parts.push(result.outcome);
  }
  return parts.length ? parts.join('; ') : null;
}

function toolNameOf(entry, block = null) {
  return firstString(block?.name, block?.tool, entry?.name, entry?.tool, entry?.toolName, entry?.function, block?.id) ?? 'tool';
}

function toolArgsOf(entry, block = null) {
  return block?.input ?? block?.args ?? block?.arguments ?? block?.parameters ?? entry?.input ?? entry?.args ?? entry?.arguments ?? entry?.parameters ?? entry?.command ?? null;
}

function entryTimestamp(entry) {
  return typeof entry?.timestamp === 'string' ? entry.timestamp : '';
}

/**
 * Extract stable atomic evidence records from raw Pi session entries.
 * User/assistant text is preserved verbatim; tool activity becomes a compact
 * summary; thinking blocks and raw result bodies are discarded.
 */
export function extractAtomics(sessionId, entries) {
  const atomics = [];
  const pendingTools = new Map();
  const pushTool = (entryId, timestamp, name, args) => {
    const { summary, paths } = summarizeToolCall(name, args);
    const id = `session:${sessionId}:tool:${entryId}`;
    const record = { id, hash: hash(summary), role: 'tool', timestamp, text: summary, tool: { name: String(name ?? 'tool') } };
    if (paths.length) record.tool.paths = paths;
    atomics.push(record);
    pendingTools.set(entryId, record);
    return record;
  };
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const entryId = typeof entry.id === 'string' && entry.id ? entry.id : `${index}`;
    const timestamp = entryTimestamp(entry);
    const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    if (type.includes('tool') && (type.includes('result') || type.includes('response'))) {
      const targetId = typeof entry.toolCallId === 'string' ? entry.toolCallId : typeof entry.callId === 'string' ? entry.callId : null;
      const target = (targetId && pendingTools.get(targetId)) ?? [...pendingTools.values()].reverse().find(r => !r.tool.outcome);
      if (target) {
        const outcome = summarizeToolResult(target.tool.name, entry.result ?? entry.output ?? entry.data ?? entry);
        if (outcome) {
          target.tool.outcome = outcome;
          target.text = `${target.text}\noutcome: ${outcome}`;
          target.hash = hash(target.text);
        }
      }
      return;
    }
    if (type.includes('tool') || (entry.tool && !entry.message) || (entry.name && !entry.message && type !== 'message' && type !== 'session')) {
      const name = toolNameOf(entry);
      pushTool(entryId, timestamp, name, toolArgsOf(entry));
      return;
    }
    if (entry.type !== 'message' || !['user', 'assistant'].includes(entry.message?.role)) return;
    const content = entry.message.content;
    const text = extractMessageText(content).trim();
    const blocks = Array.isArray(content) ? content : [];
    blocks.filter(isToolCallBlock).forEach((block, blockIndex) => {
      const name = toolNameOf(entry, block);
      pushTool(`${entryId}:${blockIndex}`, timestamp, name, toolArgsOf(entry, block));
    });
    if (!text) return;
    const id = `session:${sessionId}:${entryId}`;
    atomics.push({ id, hash: hash(text), role: entry.message.role, timestamp, text });
  });
  return atomics;
}

/**
 * Group sorted atomic records into user-anchored episodes. Assistant and
 * tool activity before the first user message stays atomic-only.
 */
export function buildEpisodes(sessionId, sortedAtomics) {
  const episodes = [];
  let current = null;
  for (const event of sortedAtomics) {
    if (event.role === 'user') {
      const shortId = event.id.slice(`session:${sessionId}:`.length);
      current = { id: `episode:${sessionId}:${shortId}`, timestamp: event.timestamp, eventIds: [], paths: [], texts: [], tools: [] };
      episodes.push(current);
    }
    if (!current) continue;
    current.eventIds.push(event.id);
    if (event.role === 'user' || event.role === 'assistant') current.texts.push({ role: event.role, text: event.text });
    else if (event.role === 'tool') {
      current.tools.push(event);
      for (const path of event.tool?.paths ?? []) if (!current.paths.includes(path)) current.paths.push(path);
    }
  }
  return episodes.map(episode => {
    const lines = [
      `## session ${sessionId} / episode ${episode.id.slice(`episode:${sessionId}:`.length)}`,
      `timestamp: ${episode.timestamp}`,
      `source-events: ${episode.eventIds.join(', ')}`,
      ''
    ];
    for (const { role, text } of episode.texts) {
      lines.push(role === 'user' ? '### User' : '### Assistant', text, '');
    }
    if (episode.tools.length) {
      lines.push('### Tools', '');
      for (const tool of episode.tools) {
        lines.push(`- ${tool.text.split('\n')[0]}`);
        const outcome = tool.tool?.outcome ?? (tool.text.includes('\noutcome: ') ? tool.text.slice(tool.text.indexOf('\noutcome: ') + 10) : null);
        if (outcome) lines.push(`  outcome: ${outcome}`);
      }
      lines.push('');
    }
    if (episode.paths.length) {
      lines.push('### Touched paths', '', ...episode.paths.sort().map(p => `- ${p}`), '');
    }
    const text = `${lines.join('\n')}\n`;
    return {
      id: episode.id,
      timestamp: episode.timestamp,
      eventIds: episode.eventIds,
      paths: episode.paths.sort(),
      text,
      hash: hash({ policy: SESSION_POLICY, id: episode.id, timestamp: episode.timestamp, eventIds: episode.eventIds, paths: episode.paths.sort(), text })
    };
  });
}

export function normalizePiSession(sessionId, entries) {
  const atomicEvidence = extractAtomics(sessionId, entries);
  const sorted = [...atomicEvidence].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  return { atomicEvidence, episodes: buildEpisodes(sessionId, sorted) };
}
