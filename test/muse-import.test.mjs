import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { readJson, optionalRead, writeJson } from '../src/util.mjs';
import { safePath } from '../src/util.mjs';
import { CONFIG_PATH } from '../src/config.mjs';
import { run } from '../src/engine.mjs';
import { collect } from '../src/collector.mjs';
import { discoverMuseSessions, loadMuseCursors, importMuseSessions, MUSE_CURSORS_PATH } from '../src/muse-import.mjs';

let seq = 0;
const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const envelope = (sessionId, payload_type, payload) => ({
  schema_version: 1, id: `rec-${sessionId}-${++seq}`, stream: { kind: 'session', id: sessionId },
  sequence: ++seq, recorded_at: 1789905617199508 + seq * 7000, record_type: 'event', durability: 'durable',
  payload_type, payload_schema_version: 1, payload
});
const meta = (sessionId, workspace_root) => envelope(sessionId, 'runtime.session.metadata', { kind: 'metadata', record: { workspace_root } });
const intent = (sessionId, text, id = `intent-${sessionId}-${++seq}`) => envelope(sessionId, 'runtime.user_intent.accepted', {
  intent_id: id, surface: 'main', semantic_kind: { kind: 'chat' },
  model_messages: [{ content: [{ kind: 'text', text }] }]
});
const assistantMsg = (sessionId, text) => envelope(sessionId, 'runtime.session', {
  kind: 'run', run_id: 'run-1',
  event: { kind: 'assistant_message_committed', message_id: `msg-${sessionId}-${++seq}`, response_id: 'r', text }
});
const toolCall = (sessionId, call_id, name, args) => envelope(sessionId, 'runtime.session', {
  kind: 'run', run_id: 'run-1',
  event: { kind: 'assistant_tool_calls_committed', message_id: `b-${++seq}`, response_id: 'r', tool_calls: [{ call_id, id: `f-${call_id}`, name, args: JSON.stringify(args) }] }
});
const toolResult = (sessionId, tool_call_id, text) => envelope(sessionId, 'runtime.session', {
  kind: 'run', run_id: 'run-1',
  event: { kind: 'tool_result_batch_committed', batch_id: `b-${++seq}`, results: [{ tool_call_id, tool_call_index: 0, text }] }
});

async function fakeStore(t, root) {
  const saved = process.env.XDG_DATA_HOME;
  const dir = await mkdtemp(join(tmpdir(), 'muse-store-'));
  t.after(() => { process.env.XDG_DATA_HOME = saved; });
  process.env.XDG_DATA_HOME = dir;
  const sessionFile = async (sessionId, records, sub = null) => {
    const d = sub ? join(dir, 'muse', 'sessions', '2026', '09', '20', 'parent', 'subagent', sessionId)
      : join(dir, 'muse', 'sessions', '2026', '09', '20', sessionId);
    await mkdir(d, { recursive: true });
    const file = join(d, 'session.jsonl');
    await writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    return file;
  };
  return { store: join(dir, 'muse', 'sessions'), sessionFile };
}

test('discovery finds sessions but never subagent transcripts', async t => {
  const f = await fixture(t);
  const { store, sessionFile } = await fakeStore(t, f.root);
  await sessionFile(sid(1), [meta(sid(1), f.root), intent(sid(1), 'Do work.')]);
  await sessionFile(sid(2), [meta(sid(2), f.root)], sid(2));
  const found = await discoverMuseSessions(store);
  assert.equal(found.length, 1);
  assert.ok(found[0].endsWith(join(sid(1), 'session.jsonl')));
});

test('import captures repo sessions, skips other repos, records cursors', async t => {
  const f = await fixture(t);
  const { sessionFile } = await fakeStore(t, f.root);
  await sessionFile(sid(1), [
    meta(sid(1), f.root), intent(sid(1), 'Keep v1 token behavior until mobile migrates.', 'intent-keep-v1'),
    assistantMsg(sid(1), 'I will inspect the queue implementation.'),
    toolCall(sid(1), 'call-1', 'read_file', { path: 'src/queue.ts' }),
    toolResult(sid(1), 'call-1', 'full file body that must not be indexed')
  ]);
  await sessionFile(sid(2), [meta(sid(2), '/elsewhere'), intent(sid(2), 'Other repo work.')]);
  const first = await importMuseSessions(f.root, f.config);
  assert.equal(first.sessions, 1);
  assert.ok(first.newRecords >= 3);
  const cursors = await loadMuseCursors(f.root);
  assert.ok(cursors[sid(1)] && cursors[sid(2)], 'both matching and non-matching files leave cursors');
  const snapshot = await collect(f.root, f.config, f.catalog);
  const episode = snapshot.sessionEpisodes.find(e => e.id === `episode:${sid(1)}:intent-keep-v1`);
  assert.ok(episode, 'muse session yields a user-anchored episode');
  assert.match(episode.text, /Keep v1 token behavior/);
  assert.match(episode.text, /read_file src\/queue\.ts/);
  assert.ok(!episode.text.includes('must not be indexed'));
  // Second import with unchanged files parses nothing.
  const second = await importMuseSessions(f.root, f.config);
  assert.deepEqual(second, { sessions: 0, newRecords: 0 });
});

test('appended records import incrementally and partial tails are ignored', async t => {
  const f = await fixture(t);
  const { sessionFile } = await fakeStore(t, f.root);
  const file = await sessionFile(sid(3), [meta(sid(3), f.root), intent(sid(3), 'First request.', 'intent-first')]);
  assert.equal((await importMuseSessions(f.root, f.config)).sessions, 1);
  await appendFile(file, JSON.stringify(assistantMsg(sid(3), 'Second turn reply.')) + '\n{"live partial tail');
  const next = await importMuseSessions(f.root, f.config);
  assert.equal(next.sessions, 1);
  assert.equal(next.newRecords, 1);
  const snapshot = await collect(f.root, f.config, f.catalog);
  assert.ok(snapshot.sessions.some(s => s.role === 'assistant' && s.text === 'Second turn reply.'));
});

test('missing store dir returns zeros without error', async t => {
  const f = await fixture(t);
  const saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(tmpdir(), `no-such-xdg-${Date.now()}`);
  t.after(() => { process.env.XDG_DATA_HOME = saved; });
  assert.deepEqual(await importMuseSessions(f.root, f.config), { sessions: 0, newRecords: 0 });
});

test('char budget defers whole files and resumes on the next run', async t => {
  const f = await fixture(t);
  const { sessionFile } = await fakeStore(t, f.root);
  await sessionFile(sid(4), [meta(sid(4), f.root), intent(sid(4), 'Alpha work.')]);
  await sessionFile(sid(5), [meta(sid(5), f.root), intent(sid(5), 'Beta work.')]);
  const tiny = { ...f.config, maxMuseImportChars: 1 };
  const first = await importMuseSessions(f.root, tiny);
  assert.equal(first.sessions, 1, 'first file imports despite the budget (progress guarantee)');
  const second = await importMuseSessions(f.root, tiny);
  assert.equal(second.sessions, 1, 'backlog drains one file per run under a tiny budget');
  const third = await importMuseSessions(f.root, tiny);
  assert.deepEqual(third, { sessions: 0, newRecords: 0 }, 'backlog drained');
});

test('museAutoImport false skips the pull in engine.run', async t => {
  const f = await fixture(t);
  const { sessionFile } = await fakeStore(t, f.root);
  await sessionFile(sid(6), [meta(sid(6), f.root), intent(sid(6), 'Should not be pulled.')]);
  await writeJson(f.root, CONFIG_PATH, { ...f.config, museAutoImport: false });
  const result = await run(f.root, { scanOnly: true });
  assert.deepEqual(result.muse, { sessions: 0, newRecords: 0 });
  assert.equal(await optionalRead(await safePath(f.root, MUSE_CURSORS_PATH)), null);
  const { loadConfig } = await import('../src/config.mjs');
  const snapshot = await collect(f.root, (await loadConfig(f.root)).config, f.catalog);
  assert.ok(!snapshot.sessions.some(s => s.text === 'Should not be pulled.'));
});

test('cursors key on the session directory even when it differs from the stream id', async t => {
  const f = await fixture(t);
  const { store } = await fakeStore(t, f.root);
  const dir = join(store, '2026', '09', '21', 'renamed-session-dir');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.jsonl'), [meta(sid(7), f.root), intent(sid(7), 'Directory differs from stream.')].map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal((await importMuseSessions(f.root, f.config)).sessions, 1);
  assert.ok((await loadMuseCursors(f.root))['renamed-session-dir']);
  assert.deepEqual(await importMuseSessions(f.root, f.config), { sessions: 0, newRecords: 0 });
});
