import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { collect } from '../src/collector.mjs';
import { claudeProjectDirName } from '../src/claude-import.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const hindsight = async (args, env = {}) => {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    return { code: 0, result: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, stderr: error.stderr };
  }
};
const jsonl = records => records.map(r => JSON.stringify(r)).join('\n') + '\n';
async function sessionFile(t, name, text) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-capture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, name), text);
  return join(dir, name);
}

const claudeLine = (sessionId, cwd, text, n) => ({ type: 'user', uuid: `u-${n}`, sessionId, cwd, promptSource: 'typed', timestamp: `2026-09-20T11:00:0${n}.000Z`, message: { role: 'user', content: text } });
const museEnvelope = (sessionId, sequence, payload_type, payload) => ({
  schema_version: 1, id: `rec-${sequence}`, stream: { kind: 'session', id: sessionId }, sequence, recorded_at: 1789905617199508 + sequence,
  record_type: 'event', durability: 'durable', payload_type, payload_schema_version: 1, payload
});

test('capture recognizes Pi, Muse, and Claude transcripts', async t => {
  const f = await fixture(t);
  const pi = await sessionFile(t, 'pi.jsonl', jsonl([
    { type: 'session', version: 3, id: 'pi-cli', timestamp: '2026-09-20T10:00:00.000Z', cwd: f.root },
    { type: 'message', id: 'e1', parentId: null, timestamp: '2026-09-20T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Pi prompt.' }] } }
  ]));
  const museId = '00000000-0000-4000-8000-00000000c11a';
  const muse = await sessionFile(t, 'session.jsonl', jsonl([
    museEnvelope(museId, 1, 'runtime.session.metadata', { kind: 'metadata', record: { workspace_root: f.root } }),
    museEnvelope(museId, 2, 'runtime.user_intent.accepted', { intent_id: 'intent-1', surface: 'main', semantic_kind: { kind: 'chat' }, model_messages: [{ content: [{ kind: 'text', text: 'Muse prompt.' }] }] })
  ]));
  const claude = await sessionFile(t, 'cs-cli.jsonl', jsonl([claudeLine('cs-cli', f.root, 'Claude prompt.', 1)]) + '{"type":"user","uuid":"partial');
  const piRun = await hindsight(['capture', pi, '--cwd', f.root]);
  assert.equal(piRun.code, 0, piRun.stderr);
  assert.deepEqual([piRun.result.captured, piRun.result.source, piRun.result.added], ['pi-cli', 'pi', 1]);
  const museRun = await hindsight(['capture', muse, '--cwd', f.root]);
  assert.equal(museRun.code, 0, museRun.stderr);
  assert.deepEqual([museRun.result.captured, museRun.result.source, museRun.result.added], [museId, 'muse', 1]);
  const claudeRun = await hindsight(['capture', claude, '--cwd', f.root]);
  assert.equal(claudeRun.code, 0, claudeRun.stderr);
  assert.deepEqual([claudeRun.result.captured, claudeRun.result.source, claudeRun.result.added], [['cs-cli'], 'claude', 1]);
  const again = await hindsight(['capture', claude, '--cwd', f.root]);
  assert.deepEqual([again.result.added, again.result.chars], [0, 0]);
  const snapshot = await collect(f.root, f.config, f.catalog);
  assert.deepEqual(snapshot.sessions.filter(s => s.role === 'user').map(s => s.text).sort(), ['Claude prompt.', 'Muse prompt.', 'Pi prompt.']);
  assert.deepEqual([...new Set(snapshot.sessionEpisodes.map(e => e.source))].sort(), ['claude', 'muse', 'pi']);
});

test('capture rejects other repositories and unknown formats', async t => {
  const f = await fixture(t);
  const foreign = await sessionFile(t, 'cs-other.jsonl', jsonl([claudeLine('cs-other', '/elsewhere/project', 'Foreign prompt.', 1)]));
  const rejected = await hindsight(['capture', foreign, '--cwd', f.root]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /Session must contain entries from this Git repository/);
  const garbage = await sessionFile(t, 'garbage.jsonl', 'hello\n{"type":"note"}\n');
  const unknown = await hindsight(['capture', garbage, '--cwd', f.root]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unrecognized session format/);
});

test('import pulls every source without curating', async t => {
  const f = await fixture(t);
  const claudeDir = await mkdtemp(join(tmpdir(), 'cli-claude-'));
  t.after(() => rm(claudeDir, { recursive: true, force: true }));
  const project = join(claudeDir, 'projects', claudeProjectDirName(f.root));
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'cs-import.jsonl'), jsonl([claudeLine('cs-import', f.root, 'Imported prompt.', 1)]));
  const run = await hindsight(['import', '--cwd', f.root], { CLAUDE_CONFIG_DIR: claudeDir });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.result.claude, { sessions: 1, newEvents: 1, deferred: null, oversized: 0 });
  assert.deepEqual(run.result.pi, { sessions: 0, newEvents: 0, deferred: null, oversized: 0 });
  assert.deepEqual(run.result.muse, { sessions: 0, newRecords: 0 });
});
