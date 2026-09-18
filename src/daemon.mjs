import { spawn } from 'node:child_process';
import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './collector.mjs';
import { lockOwnerAlive, readLockOwner } from './store.mjs';
import { safePath } from './util.mjs';

export const LOG_DIR = '.agents/curation/logs';

export function cliPath() {
  return fileURLToPath(new URL('./cli.mjs', import.meta.url));
}

function assertRunCommand(command) {
  if (command !== 'run' && command !== 'force') throw new Error(`Internal error: detached spawn supports run/force, not ${command}`);
}

// Read-only view of the cross-process run lock. Returns null when idle,
// otherwise {...owner, alive} where alive is true/false on this host and
// null when ownership cannot be established (foreign host or corrupt owner).
export async function backgroundRunStatus(root) {
  const owner = await readLockOwner(root);
  if (!owner) return null;
  return { ...owner, alive: lockOwnerAlive(owner) };
}

export async function logPathFor(root, command) {
  const name = `hindsight-${command}-${Date.now()}.log`;
  const absolute = await safePath(root, `${LOG_DIR}/${name}`);
  await mkdir(dirname(absolute), { recursive: true });
  return { absolute, relative: relative(root, absolute) };
}

// Start a curator run that outlives Pi: detached process group, stdio
// redirected to a per-run log file, parent reference released. Resolves
// fast with {pid, log}; the run itself is observed via scan and the log.
export async function spawnDetachedRun({ cwd, command, domain, spawnImpl = spawn }) {
  assertRunCommand(command);
  if (domain !== undefined && (typeof domain !== 'string' || !domain)) throw new Error('Internal error: invalid detached run domain');
  const root = await repositoryRoot(cwd);
  const status = await backgroundRunStatus(root);
  if (status) {
    if (status.alive !== false) throw new Error(`A curation run is already active (pid ${status.pid ?? 'unknown'}). Use /hindsight scan for progress or /hindsight cancel to stop it.`);
    throw new Error(`A previous run left a stale lock (pid ${status.pid ?? 'unknown'} is not running). Run /hindsight unlock, then retry.`);
  }
  const argv = [cliPath(), command, ...(domain ? [domain] : []), '--cwd', root];
  const { absolute, relative: rel } = await logPathFor(root, command);
  await appendFile(absolute, `hindsight ${command}${domain ? ` ${domain}` : ''} started ${new Date().toISOString()}\n`);
  const out = await open(absolute, 'a');
  try {
    const child = spawnImpl(process.execPath, argv, {
      cwd: root,
      detached: true,
      stdio: ['ignore', out.fd, out.fd],
      env: process.env,
      windowsHide: true,
    });
    if (!child || !Number.isSafeInteger(child.pid)) throw new Error('Failed to start the background curation process.');
    child.unref?.();
    return { pid: child.pid, log: absolute, logRelative: rel, root };
  } finally {
    await out.close();
  }
}

// Signal a live background run. Never removes the lock: a graceful stop
// releases it; a killed process leaves it for unlock and journal recovery.
export async function cancelBackgroundRun(root) {
  const status = await backgroundRunStatus(root);
  if (!status) return 'No background hindsight run is active.';
  if (status.alive === null) throw new Error(`Run lock is held on another host (${status.host ?? 'unknown'}). Refusing to signal it from here.`);
  if (status.alive === false) throw new Error(`Run process ${status.pid} is not running. Use hindsight unlock to clear the stale lock, then retry.`);
  if (status.pid === process.pid) throw new Error('Lock owner is this process; refusing to cancel self.');
  process.kill(status.pid, 'SIGTERM');
  return `Signalled background curation process ${status.pid}. Use scan to confirm it stopped.`;
}
