import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { parseCommand, tokenize } from '../src/commands.mjs';
import { backgroundRunStatus, cancelBackgroundRun, cliPath, spawnDetachedRun } from '../src/daemon.mjs';
import { writeJson } from '../src/util.mjs';
import extension from '../extension.ts';

const LOCK = '.agents/curation/run.lock';
const liveOwner = (pid = process.pid) => ({ pid, host: hostname(), token: 'test-token', startedAt: new Date().toISOString() });

function fakeSpawn(captured) {
  return (cmd, argv, options) => {
    captured.push({ cmd, argv, options });
    return { pid: 424242, unref() { captured.at(-1).unrefed = true; } };
  };
}

test('cancel parses as a first-class command', () => {
  assert.equal(parseCommand(tokenize('cancel')).command, 'cancel');
  assert.equal(parseCommand(['cancel']).command, 'cancel');
});

test('background status is idle without a lock', async t => {
  const f = await fixture(t);
  assert.equal(await backgroundRunStatus(f.root), null);
});

test('detached spawn releases Pi: detached group, ignored stdio, log file', async t => {
  const f = await fixture(t);
  const captured = [];
  const started = await spawnDetachedRun({ cwd: f.root, command: 'run', domain: 'dependencies', spawnImpl: fakeSpawn(captured) });
  assert.equal(started.pid, 424242);
  assert.equal(captured.length, 1);
  const [{ cmd, argv, options }] = captured;
  assert.equal(cmd, process.execPath);
  assert.equal(argv[0], cliPath());
  assert.deepEqual(argv.slice(1, 3), ['run', 'dependencies']);
  assert.deepEqual(argv.slice(3, 4), ['--cwd']);
  assert.equal(options.detached, true);
  assert.equal(options.stdio[0], 'ignore');
  assert.equal(typeof options.stdio[1], 'number');
  assert.equal(options.stdio[1], options.stdio[2]);
  assert.equal(captured[0].unrefed, true);
  const banner = await readFile(started.log, 'utf8');
  assert.match(banner, /hindsight run dependencies started/);
});

test('detached spawn refuses while a live run holds the lock', async t => {
  const f = await fixture(t);
  await writeJson(f.root, LOCK, liveOwner());
  t.after(() => rm(join(f.root, LOCK), { force: true }));
  const captured = [];
  await assert.rejects(
    () => spawnDetachedRun({ cwd: f.root, command: 'run', spawnImpl: fakeSpawn(captured) }),
    /already active/,
  );
  assert.equal(captured.length, 0);
});

test('detached spawn points at unlock for a stale lock', async t => {
  const f = await fixture(t);
  await writeJson(f.root, LOCK, liveOwner(2147483646));
  t.after(() => rm(join(f.root, LOCK), { force: true }));
  const captured = [];
  await assert.rejects(
    () => spawnDetachedRun({ cwd: f.root, command: 'force', spawnImpl: fakeSpawn(captured) }),
    /unlock/,
  );
  assert.equal(captured.length, 0);
});

test('cancel reports idle when no run holds the lock', async t => {
  const f = await fixture(t);
  assert.equal(await cancelBackgroundRun(f.root), 'No background hindsight run is active.');
});

test('cancel signals a live background run without removing its lock', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} return rm(join(f.root, LOCK), { force: true }); });
  await writeJson(f.root, LOCK, liveOwner(child.pid));
  const exited = new Promise(resolve => child.once('exit', resolve));
  const message = await cancelBackgroundRun(f.root);
  assert.match(message, new RegExp(`Signalled background curation process ${child.pid}`));
  await exited;
  assert.equal((await stat(join(f.root, LOCK))).isFile(), true);
});

test('cancel refuses a stale lock and points at unlock', async t => {
  const f = await fixture(t);
  await writeJson(f.root, LOCK, liveOwner(2147483646));
  t.after(() => rm(join(f.root, LOCK), { force: true }));
  await assert.rejects(() => cancelBackgroundRun(f.root), /unlock/);
});

function fakePi(collected) {
  const events = new Map(), commands = new Map();
  return {
    events,
    on: (event, handler) => events.set(event, handler),
    registerCommand: (name, options) => commands.set(name, options),
    handler: () => commands.get('hindsight').handler,
    notify: collected,
  };
}
const fakeCtx = (root, collected) => ({
  cwd: root,
  hasUI: true,
  ui: { notify: (text, level = 'info') => collected.push({ text, level }), setStatus: () => {} },
  sessionManager: { getSessionId: () => 'test-session', getBranch: () => [] },
  isProjectTrusted: () => true,
});

test('Pi run trigger returns immediately when a run is already active', async t => {
  const f = await fixture(t);
  const collected = [];
  const pi = fakePi(collected);
  extension(pi);
  await writeJson(f.root, LOCK, liveOwner());
  try {
    await pi.handler()('run', fakeCtx(f.root, collected));
  } finally {
    await rm(join(f.root, LOCK), { force: true });
  }
  assert.equal(collected.length, 1);
  assert.equal(collected[0].level, 'error');
  assert.match(collected[0].text, /already active/);
  await assert.rejects(() => stat(join(f.root, '.agents/curation/logs')), /ENOENT/);
});

test('Pi scan reports an active background run', async t => {
  const f = await fixture(t);
  const collected = [];
  const pi = fakePi(collected);
  extension(pi);
  await writeJson(f.root, LOCK, liveOwner());
  try {
    await pi.handler()('scan', fakeCtx(f.root, collected));
  } finally {
    await rm(join(f.root, LOCK), { force: true });
  }
  assert.equal(collected.length, 1);
  assert.match(collected[0].text, /Background run active: pid/);
});

test('Pi cancel trigger reports idle without a background run', async t => {
  const f = await fixture(t);
  const collected = [];
  const pi = fakePi(collected);
  extension(pi);
  await pi.handler()('cancel', fakeCtx(f.root, collected));
  assert.equal(collected.length, 1);
  assert.match(collected[0].text, /No background hindsight run is active/);
});

test('automatic agent_end stays quiet while a background run is active', async t => {
  const f = await fixture(t);
  const collected = [];
  const pi = fakePi(collected);
  extension(pi);
  await writeJson(f.root, LOCK, liveOwner());
  try {
    await pi.events.get('agent_end')(null, { cwd: f.root, isProjectTrusted: () => true, hasUI: true, ui: { notify: (text, level) => collected.push({ text, level }) } });
  } finally {
    await rm(join(f.root, LOCK), { force: true });
  }
  assert.equal(collected.length, 0);
});
