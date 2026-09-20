import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MUSE_POLICY, parseMuseRecords, isMuseSession, museSessionId, museWorkspaceRoot,
  museToPiEntries, digestMuseResult, isoFromRecordedAt
} from '../src/muse-adapter.mjs';

const SID = '01a0b486-447b-7f62-8455-c65316c0507b';
let seq = 0;
const envelope = (payload_type, payload, extra = {}) => ({
  schema_version: 1, id: `rec-${++seq}`, stream: { kind: 'session', id: SID },
  sequence: ++seq, recorded_at: 1789905617199508 + seq * 1000, record_type: 'event', durability: 'durable',
  payload_type, payload_schema_version: 1, payload, ...extra
});
const intent = (text, extra = {}) => envelope('runtime.user_intent.accepted', {
  intent_id: `intent-${seq}`, surface: 'main', semantic_kind: { kind: 'chat' },
  model_messages: [{ content: [{ kind: 'text', text }] }], ...extra
});
const assistantMsg = (text) => envelope('runtime.session', {
  kind: 'run', run_id: 'run-1',
  event: { kind: 'assistant_message_committed', message_id: `msg-${seq}`, response_id: 'resp-1', text }
});
const toolCalls = (calls) => envelope('runtime.session', {
  kind: 'run', run_id: 'run-1',
  event: { kind: 'assistant_tool_calls_committed', message_id: `b-${seq}`, response_id: 'resp-1', tool_calls: calls }
});
const results = (list) => envelope('runtime.session', {
  kind: 'run', run_id: 'run-1',
  event: { kind: 'tool_result_batch_committed', batch_id: `b-${seq}`, results: list }
});
const lines = (records) => records.map(r => JSON.stringify(r)).join('\n');

test('policy version is namespaced away from the Pi policy', () => {
  assert.match(MUSE_POLICY, /^muse-session-episode-/);
});

test('detection: Muse envelopes true, Pi header and garbage false', () => {
  assert.equal(isMuseSession(lines([intent('hi')])), true);
  assert.equal(isMuseSession('{"type":"session","id":"s1","cwd":"/repo"}\n'), false);
  assert.equal(isMuseSession('not json\n{"a":1}\n'), false);
  assert.equal(isMuseSession(''), false);
});

test('outer-frame children expand; retained markers and corrupt lines drop', () => {
  const inner = envelope('runtime.session.metadata', { kind: 'metadata', record: { workspace_root: '/repo' } });
  const text = [
    JSON.stringify({ retained_frame: 'x', children: [{ child_index: 0, record_json: JSON.stringify(inner) }] }),
    JSON.stringify({ retained_marker: 'omitted_live_only', stream: { kind: 'session', id: SID } }),
    '{"truncated live tail',
    JSON.stringify(intent('hello'))
  ].join('\n');
  const records = parseMuseRecords(text);
  assert.equal(records.length, 2);
  assert.equal(records[0].payload_type, 'runtime.session.metadata');
});

test('session identity: single stream ok, mixed streams throw, empty throws', () => {
  assert.equal(museSessionId([intent('a')]), SID);
  const other = { ...intent('b'), stream: { kind: 'session', id: 'other' } };
  assert.throws(() => museSessionId([intent('a'), other]), /multiple stream/);
  assert.throws(() => museSessionId([]), /no stream/);
});

test('workspace root prefers metadata, falls back to route facts, else null', () => {
  const meta = envelope('runtime.session.metadata', { kind: 'metadata', record: { workspace_root: '/repo' } });
  const route = envelope('runtime.session.route_facts', { kind: 'route_facts', record: { cwd: '/fallback' } });
  assert.equal(museWorkspaceRoot([route, meta]), '/repo');
  assert.equal(museWorkspaceRoot([route]), '/fallback');
  assert.equal(museWorkspaceRoot([intent('x')]), null);
});

test('user intent requires main surface and chat kind; run/started is ignored', () => {
  const started = envelope('runtime.session', { kind: 'run', run_id: 'r', event: { kind: 'started', prompt: 'same text' } });
  const records = [
    intent('Do the work.'),
    started,
    intent('Background noise.', { surface: 'worker' }),
    intent('System text.', { semantic_kind: { kind: 'status' } }),
    intent('   ')
  ];
  const entries = museToPiEntries(records);
  assert.deepEqual(entries.map(e => e.message?.role ?? e.type), ['user']);
  assert.equal(entries[0].message.content, 'Do the work.');
});

test('assistant text kept; reasoning committed dropped', () => {
  const reasoning = envelope('runtime.session', {
    kind: 'run', run_id: 'r', event: { kind: 'reasoning_committed', encrypted_content: 'Q-secret', text: '' }
  });
  const entries = museToPiEntries([reasoning, assistantMsg('Visible conclusion.')]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message.role, 'assistant');
});

test('tool projection keeps paths and commands, drops bodies and plumbing', () => {
  const entries = museToPiEntries([toolCalls([
    { call_id: 'c1', id: 'f1', name: 'edit_file', args: JSON.stringify({ path: 'src/a.ts', find: 'huge old', replace: 'huge new' }) },
    { call_id: 'c2', id: 'f2', name: 'bash', args: JSON.stringify({ command: 'npm test -- queue', description: 'run queue tests', yield_time_ms: 5 }) },
    { call_id: 'c3', id: 'f3', name: 'search', args: JSON.stringify({ pattern: 'TODO', paths: ['src'] }) },
    { call_id: 'c4', id: 'f4', name: 'write_todos', args: JSON.stringify({ todos: [{ text: 'a' }, { text: 'b' }] }) },
    { call_id: 'c5', id: 'f5', name: 'read_skill', args: JSON.stringify({ name: 'bundled:x' }) },
    { call_id: 'c6', id: 'f6', name: 'bash_input', args: JSON.stringify({ session_id: 's' }) },
    { call_id: 'c7', id: 'f7', name: 'subagent_spawn', args: JSON.stringify({ objective: 'x' }) }
  ])]);
  const byId = Object.fromEntries(entries.map(e => [e.id, e]));
  assert.deepEqual(byId.c1.input, { path: 'src/a.ts' });
  assert.deepEqual(byId.c2.input, { command: 'npm test -- queue' });
  assert.deepEqual(byId.c3.input, { pattern: 'TODO', paths: ['src'] });
  assert.deepEqual(byId.c4.input, { items: 2 });
  assert.deepEqual(byId.c5.input, { name: 'bundled:x' });
  assert.ok(!byId.c6 && !byId.c7);
});

test('bash envelope digests to exit code; output body is not passed through raw', () => {
  const digested = digestMuseResult('bash', JSON.stringify({ exit_code: 0, output: 'ok body', command: 'ls' }));
  assert.equal(digested.exitCode, 0);
  const raw = digestMuseResult('bash', 'not-json {{{');
  assert.equal(raw, 'not-json {{{');
});

test('read bodies discard; write_todos ok maps to success; edit keeps first line', () => {
  assert.deepEqual(digestMuseResult('read_file', 'full file contents here'), {});
  assert.deepEqual(digestMuseResult('read_skill', '<xml>body</xml>'), {});
  assert.deepEqual(digestMuseResult('write_todos', JSON.stringify({ items: 4, ok: true })), { success: true });
  assert.equal(digestMuseResult('edit_file', 'edited\nchanged lines: 1-2\n-huge\n+huge'), 'edited');
  assert.equal(digestMuseResult('search', ''), '');
});

test('results link to calls by tool_call_id; call below cursor is backfilled', () => {
  const callRec = toolCalls([{ call_id: 'call-9', id: 'f9', name: 'bash', args: JSON.stringify({ command: 'npm test' }) }]);
  const resRec = results([{ tool_call_id: 'call-9', tool_call_index: 0, text: JSON.stringify({ exit_code: 1, output: '1 failed' }) }]);
  const full = museToPiEntries([intent('Run tests.'), callRec, resRec]);
  const res = full.find(e => e.type === 'tool_result');
  assert.equal(res.toolCallId, 'call-9');
  assert.equal(res.result.exitCode, 1);
  // Incremental pull: call below cursor, result above. Outcome must still attach in-batch.
  const inc = museToPiEntries([intent('Run tests.'), callRec, resRec], { minSequence: callRec.sequence });
  const calls = inc.filter(e => e.type === 'tool_call');
  const res2 = inc.filter(e => e.type === 'tool_result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call-9');
  assert.equal(res2.length, 1);
});

test('stable IDs and ISO timestamps across repeated conversion', () => {
  const records = [intent('Same.'), assistantMsg('Reply.'), toolCalls([{ call_id: 'c1', name: 'read_file', args: '{"path":"x"}' }])];
  const a = museToPiEntries(records), b = museToPiEntries(records);
  assert.deepEqual(a.map(e => e.id), b.map(e => e.id));
  assert.ok(a.every(e => /\d{4}-\d{2}-\d{2}T/.test(e.timestamp)));
  assert.equal(isoFromRecordedAt(null), '');
});
