import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePiSession, buildEpisodes, summarizeToolCall, summarizeToolResult, SESSION_POLICY } from '../src/session-normalizer.mjs';
import { hash } from '../src/util.mjs';
import { fixture, put } from './helpers.mjs';
import { collect, captureSession } from '../src/collector.mjs';
import { readJson } from '../src/util.mjs';

const user = (id, text, timestamp = `2026-09-17T00:00:0${id.slice(-1)}Z`) => ({ type: 'message', id, timestamp, message: { role: 'user', content: text } });
const assistant = (id, text, timestamp = `2026-09-17T00:00:1${id.slice(-1)}Z`) => ({ type: 'message', id, timestamp, message: { role: 'assistant', content: text } });

test('user messages anchor episodes; assistant and tool activity attaches', () => {
  const { atomicEvidence, episodes } = normalizePiSession('s1', [
    { type: 'message', id: 'u1', timestamp: '2026-09-17T00:00:01Z', message: { role: 'user', content: 'Keep v1 token behavior until mobile migrates.' } },
    { type: 'message', id: 'a2', timestamp: '2026-09-17T00:00:02Z', message: { role: 'assistant', content: 'I will inspect the queue implementation.' } },
    { type: 'tool_call', id: 'c3', timestamp: '2026-09-17T00:00:03Z', name: 'read', input: { path: 'src/queue.ts' } },
    { type: 'message', id: 'u4', timestamp: '2026-09-17T00:00:04Z', message: { role: 'user', content: 'Also preserve the retry limit.' } },
  ]);
  assert.deepEqual(episodes.map(e => e.id), ['episode:s1:u1', 'episode:s1:u4']);
  assert.deepEqual(episodes[0].eventIds, ['session:s1:u1', 'session:s1:a2', 'session:s1:tool:c3']);
  assert.deepEqual(episodes[0].paths, ['src/queue.ts']);
  assert.match(episodes[0].text, /Keep v1 token behavior/);
  assert.match(episodes[0].text, /read src\/queue\.ts/);
  assert.ok(atomicEvidence.some(e => e.id === 'session:s1:tool:c3' && e.role === 'tool'));
});

test('assistant and tool activity before the first user message stays atomic-only', () => {
  const { atomicEvidence, episodes } = normalizePiSession('s1', [
    { type: 'message', id: 'a0', timestamp: '2026-09-17T00:00:00Z', message: { role: 'assistant', content: 'Early thinking without a request.' } },
    { type: 'tool_call', id: 'c0', timestamp: '2026-09-17T00:00:01Z', name: 'read', input: { path: 'src/early.ts' } },
    { type: 'message', id: 'u1', timestamp: '2026-09-17T00:00:02Z', message: { role: 'user', content: 'Now do the work.' } },
  ]);
  assert.equal(episodes.length, 1);
  assert.deepEqual(episodes[0].eventIds, ['session:s1:u1']);
  assert.ok(atomicEvidence.some(e => e.id === 'session:s1:a0'));
  assert.ok(atomicEvidence.some(e => e.id === 'session:s1:tool:c0'));
});

test('raw tool-result bodies never enter atomic evidence or episodes', () => {
  const secret = 'PASSWORD=do-not-expose\nfile bytes that must not be indexed';
  const { atomicEvidence, episodes } = normalizePiSession('s1', [
    user('u1', 'Check the configuration.'),
    { type: 'tool_call', id: 'c2', timestamp: '2026-09-17T00:00:02Z', name: 'read', input: { path: '.env' } },
    { type: 'tool_result', id: 'r3', timestamp: '2026-09-17T00:00:03Z', toolCallId: 'c2', result: { output: secret, stdout: secret } },
    { type: 'tool_call', id: 'c4', timestamp: '2026-09-17T00:00:04Z', name: 'bash', input: { command: 'npm test -- queue\nsecond line ignored' } },
    { type: 'tool_result', id: 'r5', timestamp: '2026-09-17T00:00:05Z', toolCallId: 'c4', result: { exitCode: 0, durationMs: 1200, stdout: secret } },
  ]);
  const joined = [...atomicEvidence.map(e => e.text), ...episodes.map(e => e.text)].join('\n');
  assert.ok(!joined.includes('do-not-expose'));
  assert.match(joined, /bash npm test -- queue/);
  assert.ok(!joined.includes('second line ignored'));
  assert.match(joined, /exit 0/);
});

test('file paths and structured command outcomes normalize correctly', () => {
  assert.deepEqual(summarizeToolCall('read', { path: 'src/auth.ts' }), { summary: 'read src/auth.ts', paths: ['src/auth.ts'] });
  assert.deepEqual(summarizeToolCall('edit', { file: 'src/auth.ts', content: 'huge raw body discarded' }), { summary: 'edit src/auth.ts', paths: ['src/auth.ts'] });
  assert.equal(summarizeToolResult('bash', { exitCode: 1, durationMs: 42, stdout: '3 passed, 1 failed' }), 'exit 1; 42ms; 3 passed, 1 failed');
  assert.equal(summarizeToolResult('bash', { success: true }), 'success');
});

test('reasoning blocks are discarded while text blocks survive', () => {
  const { atomicEvidence } = normalizePiSession('s1', [{
    type: 'message', id: 'a1', timestamp: '2026-09-17', message: {
      role: 'assistant',
      content: [{ type: 'thinking', text: 'private reasoning' }, { type: 'text', text: 'Visible conclusion.' }]
    }
  }]);
  assert.equal(atomicEvidence.length, 1);
  assert.equal(atomicEvidence[0].text, 'Visible conclusion.');
});

test('episode hashes include the normalization policy version', () => {
  const { episodes } = normalizePiSession('s1', [user('u1', 'Do the work.')]);
  assert.equal(episodes[0].hash, hash({ policy: SESSION_POLICY, id: 'episode:s1:u1', timestamp: episodes[0].timestamp, eventIds: ['session:s1:u1'], paths: [], text: episodes[0].text }));
});

test('version-1 archives remain readable and upgrade without inventing tool calls', async t => {
  const f = await fixture(t);
  await captureSession(f.root, 's1', [user('m1', 'Always run the repository validation command.')]);
  const archivePath = `.agents/curation/sessions/${hash('s1').slice(7)}.json`;
  const stored = await readJson(f.root, archivePath);
  assert.equal(stored.version, 2);
  // Simulate a version-1 archive captured before tool normalization existed.
  const v1 = { events: stored.events.filter(e => e.role !== 'tool').map(({ tool, ...rest }) => rest) };
  delete v1.version; delete v1.normalizationPolicy; delete v1.sessionId; delete v1.episodes;
  const { writeJson } = await import('../src/util.mjs');
  await writeJson(f.root, archivePath, v1);
  const snapshot = await collect(f.root, f.config, f.catalog);
  assert.equal(snapshot.sessionEpisodes.length, 1);
  assert.equal(snapshot.sessionEpisodes[0].id, 'episode:s1:m1');
  assert.ok(snapshot.sessions.some(s => s.id === 'session:s1:m1' && s.role === 'user'));
});

test('branch capture merges by stable identity without deleting prior evidence', async t => {
  const { atomicEvidence } = normalizePiSession('s1', [user('m1', 'First.' ), assistant('m2', 'Second.')]);
  const rebuilt = buildEpisodes('s1', [...atomicEvidence].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)));
  assert.equal(rebuilt.length, 1);
  assert.deepEqual(rebuilt[0].eventIds, ['session:s1:m1', 'session:s1:m2']);
});

test('capture stores tool atomics with roles preserved for authority checks', async t => {
  const f = await fixture(t);
  await captureSession(f.root, 's9', [
    user('u1', 'Preserve v1 token behavior until mobile is migrated.'),
    { type: 'tool_call', id: 'c2', timestamp: '2026-09-17T00:00:02Z', name: 'bash', input: { command: 'npm test' } },
  ]);
  const snapshot = await collect(f.root, f.config, f.catalog);
  const tool = snapshot.sessions.find(s => s.id === 'session:s9:tool:c2');
  assert.equal(tool?.role, 'tool');
  assert.match(snapshot.contents.get('session:s9:tool:c2'), /bash npm test/);
  const episode = snapshot.sessionEpisodes.find(e => e.id === 'episode:s9:u1');
  assert.ok(episode.eventIds.includes('session:s9:tool:c2'));
  await put(f.root, 'unused.txt', 'x');
});
