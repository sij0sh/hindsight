import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePiSession, buildEpisodes, summarizeToolCall, summarizeToolResult, sanitizeUserText, digestPiToolResult, SESSION_POLICY } from '../src/session-normalizer.mjs';
import { hash } from '../src/util.mjs';
import { fixture, put } from './helpers.mjs';
import { collect, captureSession } from '../src/collector.mjs';
import { readJson, writeJson } from '../src/util.mjs';

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

test('muse snake_case tools summarize to path-only strings', () => {
  assert.deepEqual(summarizeToolCall('read_file', { path: 'src/auth.ts' }), { summary: 'read_file src/auth.ts', paths: ['src/auth.ts'] });
  assert.deepEqual(summarizeToolCall('edit_file', { path: 'src/auth.ts', find: 'huge old body', replace: 'huge new body' }), { summary: 'edit_file src/auth.ts', paths: ['src/auth.ts'] });
  assert.deepEqual(summarizeToolCall('write_file', { path: 'src/auth.ts', content: 'huge raw body discarded' }), { summary: 'write_file src/auth.ts', paths: ['src/auth.ts'] });
});

test('search summarizes pattern and scope without touching paths', () => {
  assert.deepEqual(summarizeToolCall('search', { pattern: 'TODO', paths: ['src', 'tests'] }), { summary: 'search TODO in src, tests', paths: [] });
  assert.deepEqual(summarizeToolCall('search', { pattern: 'TODO' }), { summary: 'search TODO', paths: [] });
});

test('find, replace, and todos keys never leak into summaries', () => {
  const { atomicEvidence, episodes } = normalizePiSession('s1', [
    user('u1', 'Apply the change.'),
    { type: 'tool_call', id: 'c2', timestamp: '2026-09-17T00:00:02Z', name: 'edit_file', input: { path: 'src/a.ts', find: 'SECRET-OLD', replace: 'SECRET-NEW' } },
    { type: 'tool_call', id: 'c3', timestamp: '2026-09-17T00:00:03Z', name: 'write_todos', input: { todos: [{ text: 'SECRET-TASK' }] } },
  ]);
  const joined = [...atomicEvidence.map(e => e.text), ...episodes.map(e => e.text)].join('\n');
  assert.ok(!joined.includes('SECRET-OLD') && !joined.includes('SECRET-NEW') && !joined.includes('SECRET-TASK'));
  assert.match(joined, /edit_file src\/a\.ts/);
});

// Real Pi v3 shapes: assistant toolCall blocks and toolResult messages keyed by call id.
const piCall = (id, callId, name, args, t = '2026-09-17T00:00:02Z') => ({ type: 'message', id, timestamp: t, message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }] } });
const piResult = (id, callId, toolName, text, isError = false, t = '2026-09-17T00:00:03Z') => ({ type: 'message', id, timestamp: t, message: { role: 'toolResult', toolCallId: callId, toolName, content: [{ type: 'text', text }], isError } });

test('Pi toolResult messages attach outcomes by call id without changing atomic ids', () => {
  const { atomicEvidence, episodes } = normalizePiSession('s1', [
    user('u1', 'Run the suite.'),
    piCall('a2', 'call_A', 'bash', { command: 'npm test' }),
    piCall('a3', 'call_B', 'bash', { command: 'npm run check' }),
    piResult('r4', 'call_B', 'bash', 'lint failed\n\nCommand exited with code 2', true),
    piResult('r5', 'call_A', 'bash', 'CANARY-OUTPUT line\n# 12 passed', false)
  ]);
  const tools = Object.fromEntries(atomicEvidence.filter(e => e.role === 'tool').map(e => [e.id, e]));
  assert.deepEqual(Object.keys(tools).sort(), ['session:s1:tool:a2:0', 'session:s1:tool:a3:0']);
  assert.equal(tools['session:s1:tool:a2:0'].tool.outcome, 'exit 0; 12 passed');
  assert.equal(tools['session:s1:tool:a3:0'].tool.outcome, 'exit 2');
  assert.equal(tools['session:s1:tool:a2:0'].hash, hash(tools['session:s1:tool:a2:0'].text));
  assert.ok(!atomicEvidence.some(e => e.role === 'user' && e.id.includes('r4')), 'tool results never become user evidence');
  const joined = [...atomicEvidence.map(e => e.text), ...episodes.map(e => e.text)].join('\n');
  assert.ok(!joined.includes('CANARY-OUTPUT') && !joined.includes('lint failed'));
});

test('Pi bash failures digest to exit codes or named outcomes', () => {
  const failed = text => digestPiToolResult('bash', { isError: true, content: [{ type: 'text', text }] });
  assert.deepEqual(summarizeToolResult('bash', failed('x\n\nCommand exited with code 127')), 'exit 127');
  assert.equal(summarizeToolResult('bash', failed('partial\n\nCommand timed out after 30 seconds')), 'timeout');
  assert.equal(summarizeToolResult('bash', failed('Command aborted')), 'aborted');
  assert.equal(summarizeToolResult('bash', failed('Blocked: whole-suite test run with no timeout')), 'blocked');
  assert.equal(summarizeToolResult('bash', failed('unexpected')), 'failed');
  assert.equal(summarizeToolResult('read', digestPiToolResult('read', { isError: true, content: [] })), 'failed');
  assert.equal(digestPiToolResult('read', { isError: false, content: [{ type: 'text', text: 'file body' }] }), null);
  const passed = text => summarizeToolResult('bash', digestPiToolResult('bash', { isError: false, content: [{ type: 'text', text }] }));
  assert.equal(passed('▶ suite\nℹ tests 181\nℹ suites 0\nℹ pass 181\nℹ fail 0\n'), 'exit 0; 181 tests, 181 passed, 0 failed');
  assert.equal(passed('Expand local validation from 47 to 82 tests.\n    39\ttest(\'x\')\n  93 test/a.test.mjs'), 'exit 0', 'printed files are not test results');
});

test('an unknown call id attaches nothing, even to an unresolved call', () => {
  const { atomicEvidence } = normalizePiSession('s1', [
    user('u1', 'Go.'),
    piCall('a2', 'call_A', 'bash', { command: 'npm test' }),
    piResult('r3', 'call_missing', 'bash', 'Command exited with code 1', true)
  ]);
  assert.equal(atomicEvidence.find(e => e.role === 'tool').tool.outcome, undefined);
});

test('Pi meta entries produce no atomics or phantom tools', () => {
  const { atomicEvidence } = normalizePiSession('s1', [
    { type: 'session', version: 3, id: 's1', timestamp: '2026-09-17T00:00:00Z', cwd: '/repo' },
    { type: 'model_change', id: 'm1', timestamp: '2026-09-17T00:00:01Z', provider: 'p', modelId: 'm' },
    { type: 'thinking_level_change', id: 'm2', timestamp: '2026-09-17T00:00:01Z', thinkingLevel: 'high' },
    { type: 'session_info', id: 'm3', timestamp: '2026-09-17T00:00:01Z', name: 'Renamed session' },
    { type: 'custom_message', id: 'm4', timestamp: '2026-09-17T00:00:01Z', customType: 'x', content: 'injected' },
    { type: 'compaction', id: 'm5', timestamp: '2026-09-17T00:00:01Z', summary: 'SUMMARY' },
    { type: 'branch_summary', id: 'm6', timestamp: '2026-09-17T00:00:01Z', summary: 'SUMMARY' },
    { type: 'label', id: 'm7', timestamp: '2026-09-17T00:00:01Z', targetId: 'x', label: 'L' }
  ]);
  assert.deepEqual(atomicEvidence, []);
});

test('user text sanitizer strips injected wrappers and keeps typed arguments', () => {
  assert.equal(sanitizeUserText('<system-reminder>\nctx\n</system-reminder>\nFix the bug.'), 'Fix the bug.');
  assert.equal(sanitizeUserText('<skill name="codewiki" location="/x/SKILL.md">\nbody <pi-home>x</pi-home>\n</skill>\n\ninit'), 'init');
  assert.equal(sanitizeUserText('<file name="/tmp/pi-subagent-ab12/task.md">\nTask: delegated\n</file>\n'), '');
  assert.equal(sanitizeUserText('<ide_selection>code</ide_selection> Explain this.'), 'Explain this.');
  assert.equal(sanitizeUserText('<user-prompt-submit-hook>hook says</user-prompt-submit-hook>Ship it.'), 'Ship it.');
  const { atomicEvidence } = normalizePiSession('s1', [user('u1', '<file name="/tmp/pi-subagent-ab12/task.md">Task</file>')]);
  assert.deepEqual(atomicEvidence, [], 'a wrapper-only prompt is dropped');
});

test('edit, plan, prompt, and question bodies never leak into tool summaries', () => {
  const { atomicEvidence } = normalizePiSession('s1', [
    user('u1', 'Apply.'),
    { type: 'tool_call', id: 'c2', timestamp: '2026-09-17T00:00:02Z', name: 'edit', input: { path: 'src/a.ts', oldText: 'SECRET-A', newText: 'SECRET-B', edits: [{ oldText: 'SECRET-C' }] } },
    { type: 'tool_call', id: 'c3', timestamp: '2026-09-17T00:00:03Z', name: 'custom_tool', input: { old_string: 'SECRET-D', new_string: 'SECRET-E', prompt: 'SECRET-F', plan: 'SECRET-G', questions: ['SECRET-H'], answers: ['SECRET-I'], new_source: 'SECRET-J', mode: 'safe' } }
  ]);
  const joined = atomicEvidence.map(e => e.text).join('\n');
  assert.ok(!/SECRET-/.test(joined), joined);
  assert.match(joined, /custom_tool \{"mode":"safe"\}/);
});

test('absolute paths inside the root become repo-relative; outside paths are dropped', () => {
  const root = '/work/repo';
  assert.deepEqual(summarizeToolCall('read', { path: '/work/repo/src/a.ts' }, { root }), { summary: 'read src/a.ts', paths: ['src/a.ts'] });
  assert.deepEqual(summarizeToolCall('write', { path: '/home/someone/.ssh/config' }, { root }), { summary: 'write', paths: [] });
  assert.deepEqual(summarizeToolCall('edit', { path: '/work/repo-other/x.ts' }, { root }), { summary: 'edit', paths: [] });
  assert.deepEqual(summarizeToolCall('grep', { pattern: 'TODO', path: '/work/repo/src' }, { root }), { summary: 'grep TODO in src', paths: [] });
  assert.deepEqual(summarizeToolCall('read', { path: '/work/repo/src/a.ts' }), { summary: 'read', paths: [] }, 'without a root absolute paths are never stored');
});

test('episodes carry a source label outside the hash input', () => {
  const { episodes } = normalizePiSession('s1', [user('u1', 'Go.')], { source: 'claude' });
  assert.equal(episodes[0].source, 'claude');
  assert.match(episodes[0].text, /^source: claude$/m);
  assert.match(normalizePiSession('s1', [user('u1', 'Go.')]).episodes[0].text, /^source: pi$/m);
});

test('capture keeps a recorded outcome, reports only new chars, and sanitizes old archives on read', async t => {
  const f = await fixture(t);
  const call = piCall('a2', 'call_A', 'bash', { command: 'npm test' });
  const first = await captureSession(f.root, 's1', [user('u1', 'Test it.'), call, piResult('r3', 'call_A', 'bash', '3 passed')]);
  assert.equal(first.added, 2);
  assert.ok(first.chars > 0);
  const again = await captureSession(f.root, 's1', [user('u1', 'Test it.'), call, piResult('r3', 'call_A', 'bash', '3 passed')]);
  assert.deepEqual(again, { added: 0, changed: 0, chars: 0 });
  // A capture taken before the result arrived must not erase the outcome.
  await captureSession(f.root, 's1', [user('u1', 'Test it.'), call]);
  let snapshot = await collect(f.root, f.config, f.catalog);
  assert.equal(snapshot.sessions.find(s => s.id === 'session:s1:tool:a2:0').tool.outcome, 'exit 0; 3 passed');
  // Archives written before the sanitizer existed are cleaned at read time.
  const path = `.agents/curation/sessions/${hash('s1').slice(7)}.json`;
  const archive = await readJson(f.root, path);
  const leaked = '<skill name="x" location="y">SKILL-BODY</skill>\n\ninit';
  const wrapperOnly = '<file name="/tmp/pi-subagent-1/task.md">TASK-BODY</file>';
  archive.events.push({ id: 'session:s1:u8', hash: hash(leaked), role: 'user', timestamp: '2026-09-17T00:00:08Z', text: leaked });
  archive.events.push({ id: 'session:s1:u9', hash: hash(wrapperOnly), role: 'user', timestamp: '2026-09-17T00:00:09Z', text: wrapperOnly });
  await writeJson(f.root, path, archive);
  snapshot = await collect(f.root, f.config, f.catalog);
  assert.equal(snapshot.sessions.find(s => s.id === 'session:s1:u8').text, 'init');
  assert.ok(!snapshot.sessions.some(s => s.id === 'session:s1:u9'));
  assert.ok(![...snapshot.contents.values()].some(text => /SKILL-BODY|TASK-BODY/.test(text)));
});
