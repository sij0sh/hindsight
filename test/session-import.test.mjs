import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { optionalRead, readJson, safePath, writeJson } from '../src/util.mjs';
import { CONFIG_PATH } from '../src/config.mjs';
import { capture, run } from '../src/engine.mjs';
import { collect } from '../src/collector.mjs';
import { SESSION_CURSORS_PATH, parseJsonLines } from '../src/session-import.mjs';
import { discoverPiSessions, importPiSessions, piSessionDirName } from '../src/pi-import.mjs';
import { discoverClaudeSessions, importClaudeSessions, claudeProjectDirName } from '../src/claude-import.mjs';

const jsonl = records => records.map(r => JSON.stringify(r)).join('\n') + '\n';

// Pi v3 on-disk shapes.
const piHeader = (id, cwd, extra = {}) => ({ type: 'session', version: 3, id, timestamp: '2026-09-20T10:00:00.000Z', cwd, ...extra });
const piUser = (id, text, timestamp = '2026-09-20T10:00:01.000Z') => ({ type: 'message', id, parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 } });
const piAssistant = (id, text, timestamp = '2026-09-20T10:00:02.000Z') => ({ type: 'message', id, parentId: null, timestamp, message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: 0 } });

// Claude Code on-disk shapes.
let seq = 0;
const claudeUser = (sessionId, cwd, text) => ({ type: 'user', uuid: `u-${++seq}`, sessionId, cwd, promptSource: 'typed', timestamp: `2026-09-20T11:00:${String(seq % 60).padStart(2, '0')}.000Z`, message: { role: 'user', content: text } });

async function fakePiStore(t) {
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, flat: process.env.PI_CODING_AGENT_SESSION_DIR };
  const dir = await mkdtemp(join(tmpdir(), 'pi-store-'));
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = saved.dir;
    if (saved.flat === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = saved.flat;
    return rm(dir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = dir;
  const file = async (cwdDir, name, records) => {
    const d = join(dir, 'sessions', cwdDir);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, name), jsonl(records));
    return join(d, name);
  };
  return { dir, file };
}

async function fakeClaudeStore(t) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'claude-store-'));
  t.after(() => { process.env.CLAUDE_CONFIG_DIR = saved; return rm(dir, { recursive: true, force: true }); });
  process.env.CLAUDE_CONFIG_DIR = dir;
  const file = async (projectDir, name, records) => {
    const d = join(dir, 'projects', projectDir, ...name.split('/').slice(0, -1));
    await mkdir(d, { recursive: true });
    const path = join(d, name.split('/').at(-1));
    await writeFile(path, jsonl(records));
    return path;
  };
  return { dir, file };
}

const userTexts = snapshot => snapshot.sessions.filter(s => s.role === 'user').map(s => s.text).sort();

test('Pi pull discovers repo and subdirectory sessions and gates on the header cwd', async t => {
  const f = await fixture(t);
  const pi = await fakePiStore(t);
  const enc = piSessionDirName(f.root);
  await pi.file(enc, 'a.jsonl', [piHeader('pi-a', f.root), piUser('e1', 'Root prompt.'), piAssistant('e2', 'Root reply.')]);
  await pi.file(`${enc.slice(0, -2)}-src--`, 'b.jsonl', [piHeader('pi-b', join(f.root, 'src')), piUser('e1', 'Subdirectory prompt.')]);
  // Encoded-name neighbours of this repository must fail the header gate.
  await pi.file(`${enc.slice(0, -2)}-other--`, 'c.jsonl', [piHeader('pi-c', `${f.root}-other`), piUser('e1', 'Neighbour prompt.')]);
  await pi.file(enc, 'd.jsonl', [piHeader('pi-d', '/elsewhere'), piUser('e1', 'Foreign prompt.')]);
  await pi.file('--unrelated-project--', 'e.jsonl', [piHeader('pi-e', f.root), piUser('e1', 'Never discovered.')]);
  // A delegated subagent session opens with its task file.
  await pi.file(enc, 'f.jsonl', [piHeader('pi-f', f.root), piUser('e1', '<file name="/tmp/pi-subagent-1a/task.md">\nTask: SUBAGENT\n</file>')]);
  assert.equal((await discoverPiSessions(f.root)).length, 5);
  const first = await importPiSessions(f.root, f.config);
  assert.deepEqual(first, { sessions: 2, newEvents: 3, deferred: null, oversized: 0 });
  const snapshot = await collect(f.root, f.config, f.catalog);
  assert.deepEqual(userTexts(snapshot), ['Root prompt.', 'Subdirectory prompt.']);
  assert.ok(snapshot.sessionEpisodes.every(e => e.source === 'pi'));
  const cursors = await readJson(f.root, SESSION_CURSORS_PATH);
  assert.equal(Object.keys(cursors).length, 5, 'rejected files keep cursors so they are not re-read');
  assert.ok(!JSON.stringify(cursors).includes(f.root), 'cursor keys never store absolute paths');
  assert.deepEqual(await importPiSessions(f.root, f.config), { sessions: 0, newEvents: 0, deferred: null, oversized: 0 });
});

test('appended Pi entries import incrementally and a partial tail is tolerated', async t => {
  const f = await fixture(t);
  const pi = await fakePiStore(t);
  const path = await pi.file(piSessionDirName(f.root), 'a.jsonl', [piHeader('pi-a', f.root), piUser('e1', 'First request.')]);
  assert.equal((await importPiSessions(f.root, f.config)).newEvents, 1);
  await appendFile(path, JSON.stringify(piAssistant('e2', 'Second turn reply.')) + '\n{"type":"message","id":"e3","mess');
  assert.deepEqual(await importPiSessions(f.root, f.config), { sessions: 1, newEvents: 1, deferred: null, oversized: 0 });
  const snapshot = await collect(f.root, f.config, f.catalog);
  assert.ok(snapshot.sessions.some(s => s.role === 'assistant' && s.text === 'Second turn reply.'));
});

test('forked Pi sessions keep only their own entries', async t => {
  const f = await fixture(t);
  const pi = await fakePiStore(t);
  const forkedAt = '2026-09-20T12:00:00.000Z';
  await pi.file(piSessionDirName(f.root), 'fork.jsonl', [
    piHeader('pi-fork', f.root, { timestamp: forkedAt, parentSession: '/sessions/parent.jsonl' }),
    piUser('p1', 'Inherited parent prompt.', '2026-09-20T09:00:00.000Z'),
    piUser('n1', 'Fork prompt.', '2026-09-20T12:00:01.000Z')
  ]);
  await importPiSessions(f.root, f.config);
  assert.deepEqual(userTexts(await collect(f.root, f.config, f.catalog)), ['Fork prompt.']);
  // The live hook applies the same rule when given the header.
  await capture(f.root, 'pi-live', [piUser('p1', 'Inherited live prompt.', '2026-09-20T09:00:00.000Z'), piUser('n1', 'Live fork prompt.', '2026-09-20T12:00:01.000Z')], { header: piHeader('pi-live', f.root, { timestamp: forkedAt, parentSession: 'x' }) });
  assert.deepEqual(userTexts(await collect(f.root, f.config, f.catalog)), ['Fork prompt.', 'Live fork prompt.']);
});

test('PI_CODING_AGENT_SESSION_DIR is scanned flat', async t => {
  const f = await fixture(t);
  await fakePiStore(t);
  const flat = await mkdtemp(join(tmpdir(), 'pi-flat-'));
  t.after(() => rm(flat, { recursive: true, force: true }));
  process.env.PI_CODING_AGENT_SESSION_DIR = flat;
  await writeFile(join(flat, 'a.jsonl'), jsonl([piHeader('pi-flat', f.root), piUser('e1', 'Flat store prompt.')]));
  assert.equal((await importPiSessions(f.root, f.config)).sessions, 1);
  assert.deepEqual(userTexts(await collect(f.root, f.config, f.catalog)), ['Flat store prompt.']);
});

test('Claude pull reads top-level transcripts only and gates on the line cwd', async t => {
  const f = await fixture(t);
  const claude = await fakeClaudeStore(t);
  const enc = claudeProjectDirName(f.root);
  await claude.file(enc, 'cs-1.jsonl', [claudeUser('cs-1', f.root, 'Claude root prompt.')]);
  await claude.file(`${enc}-src`, 'cs-2.jsonl', [claudeUser('cs-2', join(f.root, 'src'), 'Claude subdirectory prompt.')]);
  await claude.file(enc, 'cs-1/subagents/agent-a1.jsonl', [claudeUser('cs-1', f.root, 'SUBAGENT prompt.')]);
  await claude.file(enc, 'cs-1/tool-results/r1.jsonl', [claudeUser('cs-1', f.root, 'TOOL-RESULT prompt.')]);
  // `/repo.x` encodes like `/repo-x`: the line cwd rejects the collision.
  await claude.file(`${enc}-x`, 'cs-3.jsonl', [claudeUser('cs-3', `${f.root}.x`, 'Colliding prompt.')]);
  await claude.file('-unrelated', 'cs-4.jsonl', [claudeUser('cs-4', f.root, 'Never discovered.')]);
  assert.equal((await discoverClaudeSessions(f.root)).length, 3);
  assert.deepEqual(await importClaudeSessions(f.root, f.config), { sessions: 2, newEvents: 2, deferred: null, oversized: 0 });
  const snapshot = await collect(f.root, f.config, f.catalog);
  assert.deepEqual(userTexts(snapshot), ['Claude root prompt.', 'Claude subdirectory prompt.']);
  assert.ok(snapshot.sessionEpisodes.every(e => e.source === 'claude'));
  assert.deepEqual(await importClaudeSessions(f.root, f.config), { sessions: 0, newEvents: 0, deferred: null, oversized: 0 });
});

test('the first file always completes; later files wait for the budget', async t => {
  const f = await fixture(t);
  const claude = await fakeClaudeStore(t);
  const enc = claudeProjectDirName(f.root);
  await claude.file(enc, 'cs-a.jsonl', [claudeUser('cs-a', f.root, 'Alpha work.')]);
  await claude.file(enc, 'cs-b.jsonl', [claudeUser('cs-b', f.root, 'Beta work.')]);
  const tiny = { ...f.config, maxClaudeImportChars: 1 };
  assert.deepEqual(await importClaudeSessions(f.root, tiny), { sessions: 1, newEvents: 1, deferred: 'budget', oversized: 0 });
  assert.deepEqual(await importClaudeSessions(f.root, tiny), { sessions: 1, newEvents: 1, deferred: null, oversized: 0 });
  assert.deepEqual(await importClaudeSessions(f.root, tiny), { sessions: 0, newEvents: 0, deferred: null, oversized: 0 });
});

test('the snapshot guard defers imports before the archive nears maxSnapshotBytes', async t => {
  const f = await fixture(t);
  const pi = await fakePiStore(t);
  const enc = piSessionDirName(f.root);
  await pi.file(enc, 'a.jsonl', [piHeader('pi-a', f.root), piUser('e1', 'A prompt long enough to fill the tiny snapshot.')]);
  await pi.file(enc, 'b.jsonl', [piHeader('pi-b', f.root), piUser('e1', 'Waiting prompt.')]);
  const small = { ...f.config, maxSnapshotBytes: 60 };
  assert.deepEqual(await importPiSessions(f.root, small), { sessions: 1, newEvents: 1, deferred: 'maxSnapshotBytes', oversized: 0 });
  assert.equal((await importPiSessions(f.root, small)).deferred, 'maxSnapshotBytes', 'stored archives count toward the guard');
});

test('oversized and unparseable transcripts never throw', async t => {
  const f = await fixture(t);
  const pi = await fakePiStore(t);
  const enc = piSessionDirName(f.root);
  await pi.file(enc, 'big.jsonl', [piHeader('pi-big', f.root), piUser('e1', 'x'.repeat(400))]);
  await pi.file(enc, 'junk.jsonl', []);
  await writeFile(join(pi.dir, 'sessions', enc, 'junk.jsonl'), 'not json\n{"half":');
  const result = await importPiSessions(f.root, { ...f.config, maxFileBytes: 1 });
  assert.deepEqual(result, { sessions: 0, newEvents: 0, deferred: null, oversized: 1 });
  assert.deepEqual(parseJsonLines('{"a":1}\n\n[1]\nnull\n{"b":'), [{ a: 1 }]);
});

test('AutoImport switches skip the Pi and Claude pulls in engine.run', async t => {
  const f = await fixture(t);
  const pi = await fakePiStore(t);
  const claude = await fakeClaudeStore(t);
  await pi.file(piSessionDirName(f.root), 'a.jsonl', [piHeader('pi-a', f.root), piUser('e1', 'Pi should not be pulled.')]);
  await claude.file(claudeProjectDirName(f.root), 'cs.jsonl', [claudeUser('cs', f.root, 'Claude should not be pulled.')]);
  await writeJson(f.root, CONFIG_PATH, { ...f.config, piAutoImport: false, claudeAutoImport: false });
  const idle = { sessions: 0, newEvents: 0, deferred: null, oversized: 0 };
  const result = await run(f.root, { scanOnly: true });
  assert.deepEqual([result.pi, result.claude], [idle, idle]);
  assert.equal(await optionalRead(await safePath(f.root, SESSION_CURSORS_PATH)), null);
  await writeJson(f.root, CONFIG_PATH, f.config);
  const enabled = await run(f.root, { scanOnly: true });
  assert.deepEqual([enabled.pi.sessions, enabled.claude.sessions], [1, 1]);
});
