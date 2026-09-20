/**
 * Muse Code (`muse`) session adapter.
 *
 * Muse stores per-session JSONL event envelopes under
 * `${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<uuid>/session.jsonl`.
 * This module is pure: it parses envelopes and projects the small keep-list
 * (user intents, assistant messages, tool calls, tool outcomes) into the
 * legacy Pi entry shape consumed by `normalizePiSession`. Raw bodies
 * (file contents, shell output, diffs, skill XML, reasoning ciphertext)
 * never leave this module except as first-line outcomes, exit codes, or
 * test counts. Everything else (orchestration, reminders, diagnostics)
 * is dropped.
 */

/** Serialization policy version for Muse-derived evidence. Pi policy is untouched. */
export const MUSE_POLICY = 'muse-session-episode-v1';

// Interactive-shell plumbing and subagent orchestration carry no repo intent.
const SKIPPED_TOOLS = new Set(['bash_input', 'subagent_spawn', 'subagent_read_result']);

// Per-tool safe arg projection. Bodies (find/replace/content/todos) are dropped here;
// RAW_KEYS in session-normalizer.mjs is the second line of defense.
const ARG_PROJECTION = {
  read_file: ['path'],
  edit_file: ['path'],
  write_file: ['path'],
  bash: ['command'],
  search: ['pattern', 'paths'],
  write_todos: ['items'],
  read_skill: ['name']
};

function parseArgs(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function projectArgs(name, raw) {
  const args = parseArgs(raw);
  if (name === 'write_todos') {
    const todos = Array.isArray(args.todos) ? args.todos.length : 0;
    return { items: todos };
  }
  const keys = ARG_PROJECTION[name];
  if (!keys) return args;
  const projected = {};
  for (const key of keys) if (args[key] !== undefined) projected[key] = args[key];
  return projected;
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].trim();
}

/**
 * Reduce a raw tool result body to a pre-digested outcome for
 * `summarizeToolResult`. Bodies are discarded; only exit codes, first
 * lines, and (via summarizeToolResult) test counts survive.
 */
export function digestMuseResult(name, text) {
  const body = typeof text === 'string' ? text : '';
  if (name === 'bash') {
    try {
      const envelope = JSON.parse(body);
      if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
        const digested = {};
        if (envelope.exit_code !== undefined || envelope.exitCode !== undefined) {
          digested.exitCode = envelope.exit_code ?? envelope.exitCode;
        }
        if (typeof envelope.output === 'string' && envelope.output) digested.output = envelope.output;
        return digested;
      }
    } catch { /* not an envelope: fall through to raw text scan */ }
    return body;
  }
  // File contents and skill XML are bodies: discard entirely, keep the call summary.
  if (name === 'read_file' || name === 'read_skill') return {};
  if (name === 'write_todos') {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
        return { success: parsed.ok };
      }
    } catch { /* fall through to first line */ }
  }
  // edit_file (diff hunk), write_file ("wrote N bytes"), search matches:
  // first line only; summarizeToolResult keeps test counts or returns null.
  return firstLine(body);
}

export function isoFromRecordedAt(recordedAt) {
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) return '';
  try { return new Date(Math.floor(recordedAt / 1000)).toISOString(); }
  catch { return ''; }
}

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(b => b && b.kind === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

/**
 * Parse raw JSONL text into Muse envelope records. Expands outer-frame
 * children, drops retained markers and unparseable lines (a live file may
 * end mid-line while Muse is writing).
 */
export function parseMuseRecords(text) {
  const records = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); }
    catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.retained_marker) continue;
    if (Array.isArray(obj.children)) {
      for (const child of obj.children) {
        if (!child || typeof child.record_json !== 'string') continue;
        try {
          const inner = JSON.parse(child.record_json);
          if (inner && typeof inner === 'object') records.push(inner);
        } catch { /* skip corrupt child */ }
      }
      continue;
    }
    records.push(obj);
  }
  return records;
}

/** True when text holds at least one Muse envelope record. Pi files yield false. */
export function isMuseSession(text) {
  return parseMuseRecords(text).some(r => typeof r?.stream?.id === 'string' && typeof r?.payload_type === 'string');
}

/** Session identity is the envelope stream ID. Rejects files mixing streams. */
export function museSessionId(records) {
  const ids = new Set();
  for (const r of records ?? []) if (typeof r?.stream?.id === 'string') ids.add(r.stream.id);
  if (!ids.size) throw new Error('Muse session has no stream identity');
  if (ids.size > 1) throw new Error('Muse session mixes multiple stream identities');
  return [...ids][0];
}

/** Repo signal: metadata workspace_root, else route_facts cwd, else null. */
export function museWorkspaceRoot(records) {
  let fallback = null;
  for (const r of records ?? []) {
    const payload = r?.payload;
    if (r?.payload_type === 'runtime.session.metadata') {
      const root = payload?.record?.workspace_root;
      if (typeof root === 'string' && root) return root;
    }
    if (r?.payload_type === 'runtime.session.route_facts' && fallback === null) {
      const cwd = payload?.record?.cwd;
      if (typeof cwd === 'string' && cwd) fallback = cwd;
    }
  }
  return fallback;
}

function eventOf(record) {
  const kind = record?.payload?.kind;
  const event = record?.payload?.event;
  return { kind, event: event && typeof event === 'object' ? event : {} };
}

/**
 * Project Muse records into legacy Pi entries for `normalizePiSession`.
 * Accepts records in any order; emits in stream-sequence order.
 * `minSequence` filters already-imported records; tool calls referenced by
 * included results are backfilled so outcomes attach within one batch.
 */
export function museToPiEntries(records, { minSequence = -1 } = {}) {
  const sorted = [...(records ?? [])]
    .filter(r => Number.isSafeInteger(r?.sequence))
    .sort((a, b) => a.sequence - b.sequence);
  const included = sorted.filter(r => r.sequence > minSequence);
  const callNames = new Map();
  for (const r of sorted) {
    const { kind, event } = eventOf(r);
    if (kind === 'run' && event.kind === 'assistant_tool_calls_committed') {
      for (const call of event.tool_calls ?? []) {
        if (call && typeof call.call_id === 'string') callNames.set(call.call_id, call.name);
      }
    }
  }
  // Backfill calls referenced by included results so outcomes attach in-batch.
  const includedCallIds = new Set();
  for (const r of included) {
    const { kind, event } = eventOf(r);
    if (kind === 'run' && event.kind === 'assistant_tool_calls_committed') {
      for (const call of event.tool_calls ?? []) {
        if (call && typeof call.call_id === 'string') includedCallIds.add(call.call_id);
      }
    }
  }
  const neededCallIds = new Set();
  for (const r of included) {
    const { kind, event } = eventOf(r);
    if (kind === 'run' && event.kind === 'tool_result_batch_committed') {
      for (const result of event.results ?? []) {
        const id = result?.tool_call_id;
        if (typeof id === 'string' && !includedCallIds.has(id) && callNames.has(id)) neededCallIds.add(id);
      }
    }
  }
  const backfill = neededCallIds.size
    ? sorted.filter(r => {
      const { kind, event } = eventOf(r);
      return kind === 'run' && event.kind === 'assistant_tool_calls_committed' &&
        (event.tool_calls ?? []).some(c => neededCallIds.has(c?.call_id));
    })
    : [];
  const entries = [];
  for (const r of [...backfill, ...included].sort((a, b) => a.sequence - b.sequence)) {
    const timestamp = isoFromRecordedAt(r.recorded_at);
    if (r.payload_type === 'runtime.user_intent.accepted') {
      const payload = r.payload ?? {};
      const surface = payload.surface;
      const semantic = payload.semantic_kind?.kind;
      if (surface !== undefined && surface !== 'main') continue;
      if (semantic !== undefined && semantic !== 'chat') continue;
      const text = (payload.model_messages ?? []).map(m => textOfBlocks(m?.content)).join('\n').trim();
      if (!text || typeof payload.intent_id !== 'string') continue;
      entries.push({ type: 'message', id: payload.intent_id, timestamp, message: { role: 'user', content: text } });
      continue;
    }
    const { kind, event } = eventOf(r);
    if (kind !== 'run') continue;
    if (event.kind === 'assistant_message_committed') {
      const text = typeof event.text === 'string' ? event.text.trim() : '';
      if (!text || typeof event.message_id !== 'string') continue;
      entries.push({ type: 'message', id: event.message_id, timestamp, message: { role: 'assistant', content: text } });
    } else if (event.kind === 'assistant_tool_calls_committed') {
      for (const call of event.tool_calls ?? []) {
        if (!call || typeof call.call_id !== 'string') continue;
        if (SKIPPED_TOOLS.has(call.name)) continue;
        entries.push({ type: 'tool_call', id: call.call_id, timestamp, name: call.name ?? 'tool', input: projectArgs(call.name, call.args) });
      }
    } else if (event.kind === 'tool_result_batch_committed') {
      (event.results ?? []).forEach((result, index) => {
        if (!result || typeof result.tool_call_id !== 'string') return;
        entries.push({
          type: 'tool_result', id: `${r.id ?? r.sequence}:${index}`, timestamp,
          toolCallId: result.tool_call_id,
          result: digestMuseResult(callNames.get(result.tool_call_id), result.text)
        });
      });
    }
  }
  return entries;
}
