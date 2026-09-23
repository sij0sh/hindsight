import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { collect, captureClaudeSession } from '../src/collector.mjs';
import { claudeToPiEntries, isClaudeSession, projectClaudeArgs, digestClaudeResult } from '../src/claude-adapter.mjs';
import { summarizeToolResult } from '../src/session-normalizer.mjs';

const SID = 'c1a0de00-0000-4000-8000-000000000001';
let seq = 0;
const line = (type, message, extra = {}) => ({
  type, uuid: `uuid-${++seq}`, parentUuid: null, sessionId: SID, cwd: '/work/repo',
  timestamp: `2026-09-20T10:00:${String(seq % 60).padStart(2, '0')}Z`, message, ...extra
});
const typed = (text, extra = {}) => line('user', { role: 'user', content: text }, { promptSource: 'typed', ...extra });
const said = (text, extra = {}) => line('assistant', { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] }, extra);
const toolUse = (id, name, input) => line('assistant', { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] });
const toolResult = (id, content, { isError = false, toolUseResult } = {}) => line('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, { promptSource: 'system', toolUseResult });

const userTexts = entries => entries.filter(e => e.type === 'message' && e.message.role === 'user').map(e => e.message.content);
const only = lines => claudeToPiEntries(lines).get(SID).entries;

test('only human-typed prompts become user entries', () => {
  const entries = only([
    { type: 'summary', summary: 'SUMMARY-LINE', leafUuid: 'x' },
    typed('Keep the retry budget at three attempts.'),
    line('user', { role: 'user', content: 'SDK-PROMPT' }, { promptSource: 'sdk' }),
    line('user', { role: 'user', content: '<task-notification>TASK-DONE</task-notification>' }, { promptSource: 'system' }),
    line('user', { role: 'user', content: '<local-command-caveat>CAVEAT</local-command-caveat>' }, { isMeta: true }),
    line('user', { role: 'user', content: '<command-name>/clear</command-name>' }, { promptSource: 'typed' }),
    line('user', { role: 'user', content: '<local-command-stdout>STDOUT</local-command-stdout>' }, { promptSource: 'typed' }),
    line('user', { role: 'user', content: 'This session is being continued from COMPACTED' }, { promptSource: 'typed', isCompactSummary: true }),
    line('user', { role: 'user', content: 'SIDECHAIN-PROMPT' }, { promptSource: 'typed', isSidechain: true }),
    line('user', { role: 'user', content: 'ORIGIN-TASK' }, { promptSource: 'typed', origin: { kind: 'task-notification' } }),
    line('assistant', { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'SYNTHETIC' }] }),
    said('API-ERROR', { isApiErrorMessage: true }),
    line('assistant', { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'THINKING' }] }),
    { type: 'attachment', uuid: 'att', sessionId: SID, attachment: { content: 'ATTACHMENT' } },
    { type: 'system', uuid: 'sys', sessionId: SID, content: 'SYSTEM' },
    said('I will keep three attempts.')
  ]);
  assert.deepEqual(userTexts(entries), ['Keep the retry budget at three attempts.']);
  const joined = JSON.stringify(entries);
  for (const leak of ['SUMMARY-LINE', 'SDK-PROMPT', 'TASK-DONE', 'CAVEAT', '/clear', 'STDOUT', 'COMPACTED', 'SIDECHAIN', 'ORIGIN-TASK', 'SYNTHETIC', 'API-ERROR', 'THINKING', 'ATTACHMENT', 'SYSTEM']) {
    assert.ok(!joined.includes(leak), leak);
  }
  assert.deepEqual(entries.filter(e => e.message?.role === 'assistant').map(e => e.message.content), ['I will keep three attempts.']);
});

test('legacy transcripts without promptSource fall back to the marker blocklist', () => {
  const legacy = (text) => line('user', { role: 'user', content: text });
  const entries = only([
    legacy('<command-name>/model</command-name>\n<command-args>opus</command-args>'),
    legacy('<bash-input>ls</bash-input>'),
    legacy('[Request interrupted by user]'),
    legacy('This session is being continued from a previous conversation.'),
    legacy('<system-reminder>ctx</system-reminder>\nUse the queue adapter.'),
    line('user', { role: 'user', content: [{ type: 'text', text: 'Block prompt.' }, { type: 'image', source: {} }] }),
    line('user', { role: 'user', content: [{ type: 'text', text: 'Mixed' }, { type: 'document', source: {} }] })
  ]);
  assert.deepEqual(userTexts(entries), ['Use the queue adapter.', 'Block prompt.']);
});

test('tool_use links to its tool_result and bodies never survive', () => {
  const entries = only([
    typed('Update the config.'),
    toolUse('toolu_read', 'Read', { file_path: '/work/repo/src/a.ts' }),
    toolResult('toolu_read', 'READ-BODY', { toolUseResult: { type: 'text', file: { content: 'READ-BODY' } } }),
    toolUse('toolu_edit', 'Edit', { file_path: '/work/repo/src/a.ts', old_string: 'OLD-BODY', new_string: 'NEW-BODY' }),
    toolUse('toolu_write', 'Write', { file_path: '/work/repo/src/b.ts', content: 'WRITE-BODY' }),
    toolUse('toolu_agent', 'Agent', { subagent_type: 'Explore', description: 'Find callers', prompt: 'AGENT-PROMPT' }),
    toolUse('toolu_plan', 'ExitPlanMode', { plan: 'PLAN-BODY' }),
    toolUse('toolu_bash', 'Bash', { command: 'npm test', description: 'Run tests' }),
    toolResult('toolu_bash', 'FAILURE-OUTPUT\nExit code 1', { isError: true, toolUseResult: 'Error: Exit code 1' })
  ]);
  const calls = entries.filter(e => e.type === 'tool_call');
  assert.deepEqual(calls.map(c => [c.id, c.name, c.input]), [
    ['toolu_read', 'Read', { path: '/work/repo/src/a.ts' }],
    ['toolu_edit', 'Edit', { path: '/work/repo/src/a.ts' }],
    ['toolu_write', 'Write', { path: '/work/repo/src/b.ts' }],
    ['toolu_agent', 'Agent', { subagent_type: 'Explore', description: 'Find callers' }],
    ['toolu_plan', 'ExitPlanMode', {}],
    ['toolu_bash', 'Bash', { command: 'npm test' }]
  ]);
  const bash = entries.find(e => e.type === 'tool_result' && e.toolCallId === 'toolu_bash');
  assert.equal(summarizeToolResult('Bash', bash.result), 'exit 1');
  assert.deepEqual(userTexts(entries), ['Update the config.'], 'tool results never become user prompts');
  assert.ok(!/READ-BODY|OLD-BODY|NEW-BODY|WRITE-BODY|AGENT-PROMPT|PLAN-BODY/.test(JSON.stringify(calls)));
});

test('result digests keep only outcomes', () => {
  assert.deepEqual(digestClaudeResult('Read', { is_error: false, content: 'BODY' }, { file: { content: 'BODY' } }), {});
  assert.deepEqual(digestClaudeResult('Edit', { is_error: true, content: 'String not found' }), { success: false });
  assert.deepEqual(digestClaudeResult('Bash', { is_error: false, content: 'ignored' }, { stdout: '# 7 passed', stderr: '', interrupted: false }), { exitCode: 0, output: '# 7 passed' });
  assert.deepEqual(digestClaudeResult('Bash', { is_error: false, content: '' }, { stdout: '', interrupted: true }), { outcome: 'interrupted' });
  assert.deepEqual(digestClaudeResult('Bash', { is_error: true, content: [{ type: 'text', text: 'denied' }] }), { success: false });
  assert.deepEqual(projectClaudeArgs('WebFetch', { url: 'https://example.com/docs/page?token=SECRET#frag', prompt: 'P' }), { url: 'https://example.com/docs/page' });
  assert.deepEqual(projectClaudeArgs('TodoWrite', { todos: [{ content: 'TODO-BODY' }, {}] }), { items: 2 });
  assert.deepEqual(projectClaudeArgs('mcp__server__tool', { anything: 'x' }), {});
  assert.deepEqual(projectClaudeArgs('Grep', { pattern: 'TODO', path: '', output_mode: 'content' }), { pattern: 'TODO' });
});

test('lines group by their own sessionId, falling back to the file name', () => {
  const other = 'c1a0de00-0000-4000-8000-000000000002';
  const sessions = claudeToPiEntries([
    typed('First session prompt.'),
    typed('Resumed session prompt.', { sessionId: other, cwd: '/work/repo/sub' }),
    typed('Anonymous prompt.', { sessionId: undefined })
  ], { sessionId: 'from-file' });
  assert.deepEqual([...sessions.keys()], [SID, other, 'from-file']);
  assert.equal(sessions.get(other).cwd, '/work/repo/sub');
  assert.ok(isClaudeSession([typed('x')]));
  assert.ok(!isClaudeSession([{ type: 'session', version: 3, id: 'pi', cwd: '/x' }]));
});

test('captured Claude evidence is repo-relative, labelled, and outcome-bearing', async t => {
  const f = await fixture(t);
  const at = (l) => ({ ...l, cwd: f.root });
  const lines = [
    at(typed('Never retry idempotency failures.')),
    at(line('user', { role: 'user', content: '<task-notification>NOT-HUMAN</task-notification>' }, { promptSource: 'system' })),
    at(toolUse('toolu_1', 'Edit', { file_path: `${f.root}/src/main.ts`, old_string: 'OLD-BODY', new_string: 'NEW-BODY' })),
    at(toolResult('toolu_1', 'ok')),
    at(toolUse('toolu_2', 'Bash', { command: 'npm test' })),
    at(toolResult('toolu_2', 'x', { toolUseResult: { stdout: 'CANARY\n# 4 passed', interrupted: false } }))
  ];
  const { entries } = claudeToPiEntries(lines).get(SID);
  const result = await captureClaudeSession(f.root, SID, entries);
  assert.equal(result.added, 3);
  const snapshot = await collect(f.root, f.config, f.catalog);
  const atomics = snapshot.sessions.filter(s => s.id.startsWith(`session:${SID}:`));
  assert.deepEqual(atomics.filter(a => a.role === 'user').map(a => a.text), ['Never retry idempotency failures.']);
  const edit = atomics.find(a => a.id === `session:${SID}:tool:toolu_1`);
  assert.deepEqual(edit.tool.paths, ['src/main.ts']);
  assert.equal(atomics.find(a => a.id === `session:${SID}:tool:toolu_2`).tool.outcome, 'exit 0; 4 passed');
  const episode = snapshot.sessionEpisodes.find(e => e.id.startsWith(`episode:${SID}:`));
  assert.equal(episode.source, 'claude');
  const all = [...snapshot.contents.values()].join('\n');
  assert.ok(!/NOT-HUMAN|OLD-BODY|NEW-BODY|CANARY/.test(all));
});
