import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, mkdir, open, rename, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';

export const hash = value => `sha256:${createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex')}`;
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function assert(condition, message) { if (!condition) throw new Error(message); }
export async function optionalRead(file) {
  try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function validRelative(path) {
  assert(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && !path.split('/').some(p => p === '..' || p === '.' || !p), `Unsafe relative path: ${path}`);
  return path;
}
// Refuse symlinks in every existing path component, including the final file.
export async function safePath(root, path) {
  validRelative(path);
  let current = await realpath(root);
  for (const part of path.split('/')) {
    current = resolve(current, part);
    try { assert(!(await lstat(current)).isSymbolicLink(), `Symlink refused: ${path}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const rel = relative(await realpath(root), current);
  assert(rel && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Path escapes repository');
  return current;
}
export async function atomicWrite(root, path, content) {
  const target = await safePath(root, path);
  await mkdir(dirname(target), { recursive: true });
  await safePath(root, path);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const fd = await open(temp, 'wx', 0o600);
    try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
    await safePath(root, path);
    await rename(temp, target);
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export const writeJson = (root, path, value) => atomicWrite(root, path, `${JSON.stringify(value, null, 2)}\n`);
export async function readJson(root, path, fallback = null) {
  const text = await optionalRead(await safePath(root, path));
  if (text === null) return fallback;
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${path}; restore or repair it before continuing.`); }
}
// A deliberately small, documented glob language: *, **, ?. No regex input.
export function glob(pattern, path) {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`).test(path);
}
export const matches = (patterns, path) => patterns.some(pattern => glob(pattern, path));
