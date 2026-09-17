import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readlink, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assert, hash, matches, optionalRead, safePath, readJson, writeJson } from './util.mjs';

const exec = promisify(execFile);
export async function git(root, args, optional = false) {
  try { return (await exec('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 20000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout; }
  catch (error) { if (optional && error.code === 128) return null; throw error; }
}
export async function repositoryRoot(cwd) {
  const result = await git(cwd, ['rev-parse', '--show-toplevel']);
  return realpath(result.trim());
}
const generated = p => p === '.agents/curation' || p.startsWith('.agents/curation/') || p.startsWith('.agents/engineering/');
export const isSensitive = (p, config) => matches(config.sensitive, p) && !matches(config.sensitiveAllow, p);
export function features(text = '') {
  // Lexical signals, intentionally NOT a complete language parser or resolved import graph.
  return {
    imports: [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)["']([^"']+)["']/g)].map(m => m[1]).sort(),
    execution: [...new Set(text.match(/\b(?:cron|schedule|Worker|Queue|consume|subscribe|setInterval|createServer)\b/g) ?? [])].sort(),
    security: [...new Set(text.match(/\b(?:exec|execSync|spawn|eval|readFile|writeFile|fetch|createCipheriv|verify|sign|authorize|authenticate)\b/g) ?? [])].sort(),
    lines: text.split('\n').length,
    todos: (text.match(/\b(?:TODO|FIXME|HACK)\b/g) ?? []).length
  };
}
export async function collect(root, config, catalog) {
  root = await repositoryRoot(root);
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'], true))?.trim() ?? null;
  const committed = Object.create(null);
  if (head) {
    for (const record of (await git(root,['ls-tree','-r','-z',head])).split('\0').filter(Boolean)) {
      const match=/^(\d+) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
      assert(match,'Invalid Git tree entry');committed[match[4]]={mode:match[1],oid:match[3]};
    }
  }
  const indexRaw = await git(root, ['ls-files', '--stage', '-z']);
  const index = Object.create(null);
  for (const record of indexRaw.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(record);
    assert(match && match[3] === '0', 'Resolve Git index conflicts before curating');
    index[match[4]] = { mode: match[1], oid: match[2] };
  }
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const paths = [...new Set([...Object.keys(committed), ...Object.keys(index), ...untracked])].filter(p => !generated(p) && !matches(config.exclude, p)).sort();
  assert(paths.length <= config.maxFiles, `Repository exceeds maxFiles (${config.maxFiles}); narrow exclusions or raise the limit`);
  const files = Object.create(null), contents = new Map();
  let bytes = 0;
  for (const path of paths) {
    const full = join(root, path);
    let stat;
    try { stat = await lstat(full); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const staged = index[path] ?? null;
    const headEntry = committed[path] ?? null;
    const addLayer = async (layer,entry,workingOid) => {
      if (!entry || entry.mode === '160000' || entry.mode === '120000' || entry.oid === workingOid || isSensitive(path,config)) return;
      const size=Number((await git(root,['cat-file','-s',entry.oid])).trim());
      if (size > config.maxFileBytes) return;
      bytes+=size;assert(bytes<=config.maxSnapshotBytes,'Repository layers exceed maxSnapshotBytes');
      const text=await git(root,['cat-file','blob',entry.oid]);
      if (!text.includes('\0')) contents.set(`${layer}:${path}`,text);
    };
    if (!stat) {
      files[path] = { hash: hash({ missing: true, staged, committed:headEntry }), missing: true, staged, committed:headEntry };
      await addLayer('index',staged,null);
      if (headEntry?.oid !== staged?.oid) await addLayer('head',headEntry,null);
      continue;
    }
    if (stat.isSymbolicLink()) {
      files[path] = { hash: hash({ link: await readlink(full), staged, committed:headEntry }), unreadable: 'symlink', staged, committed:headEntry }; continue;
    }
    if (staged?.mode === '160000') {
      files[path] = { hash: hash({staged,committed:headEntry}), unreadable: 'submodule: pointer only; inspect separately', staged, committed:headEntry }; continue;
    }
    assert(stat.isFile(), `Unsupported repository entry: ${path}`);
    await safePath(root, path);
    // Hash even large/binary/private inputs, but do not expose their contents to the model.
    assert(stat.size <= config.maxSnapshotBytes, `File too large for bounded snapshot: ${path}`);
    bytes += stat.size;
    assert(bytes <= config.maxSnapshotBytes, 'Repository exceeds maxSnapshotBytes; adjust configuration');
    const buffer = await readFile(full);
    const text = buffer.toString('utf8');
    const unreadable = isSensitive(path, config) ? 'sensitive input' : buffer.includes(0) ? 'binary input' : stat.size > config.maxFileBytes ? 'file exceeds maxFileBytes' : null;
    files[path] = { hash: hash({ content: hash(buffer), executable: Boolean(stat.mode & 0o111), staged, committed:headEntry }), staged, committed:headEntry, ...(unreadable ? { unreadable } : { features: features(text) }) };
    if (!unreadable) contents.set(`file:${path}`, text);
    const oidLength=staged?.oid.length ?? headEntry?.oid.length ?? 40;
    const workingOid=createHash(oidLength===64?'sha256':'sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
    await addLayer('index',staged,workingOid);
    if (headEntry?.oid !== staged?.oid) await addLayer('head',headEntry,workingOid);
  }
  const documents = Object.create(null);
  for (const doc of catalog.documents) {
    const content = await optionalRead(await safePath(root, doc.path));
    assert(content === null || content.length <= config.maxDocumentChars, `${doc.path} exceeds maxDocumentChars`);
    documents[doc.id] = { path: doc.path, hash: content === null ? null : hash(content), content };
    if (content !== null) contents.set(`doc:${doc.id}`, content);
  }
  const history = head ? await git(root, ['log', `-${config.historyWindow}`, '--format=commit:%H', '--name-only', '-z']) : '';
  const churn = Object.create(null);
  for (const token of history.split('\0')) {
    const path = token.replace(/^\n+/, '');
    if (path in files) churn[path] = (churn[path] ?? 0) + 1;
  }
  const sessions = await collectSessions(root, contents, config);
  const snapshotHash = hash({ files: Object.fromEntries(Object.entries(files).map(([p, f]) => [p, f.hash])), sessions: Object.fromEntries(sessions.map(s => [s.id, s.hash])), churn });
  return { root, head, files, documents, sessions, contents, churn, snapshotHash };
}
export function sessionEvents(sessionId, entries) {
  return entries.filter(e => e.type === 'message' && ['user', 'assistant'].includes(e.message?.role)).flatMap(e => {
    const content = e.message.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
    if (!text.trim()) return [];
    const id = `session:${sessionId}:${e.id}`;
    return [{ id, hash: hash(text), role: e.message.role, timestamp: e.timestamp ?? '', text }];
  });
}
export async function captureSession(root, sessionId, entries) {
  const events = sessionEvents(sessionId, entries);
  // Merge branches by stable entry identity; do not erase previously captured evidence.
  const path = `.agents/curation/sessions/${hash(sessionId).slice(7)}.json`;
  const old = await readJson(root, path, { events: [] });
  const merged = new Map(old.events.map(e => [e.id, e]));
  events.forEach(e => merged.set(e.id, e));
  if (events.length) await writeJson(root, path, { events: [...merged.values()] });
}
async function collectSessions(root, contents, config) {
  const dir = await safePath(root, '.agents/curation/sessions');
  let paths = [];
  try { paths = await readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const events = new Map(); let bytes = 0;
  for (const path of paths.filter(p => p.endsWith('.json')).sort()) {
    const data = await readJson(root, `.agents/curation/sessions/${path}`);
    assert(Array.isArray(data.events), `Invalid session inventory ${path}`);
    for (const e of data.events) {
      assert(typeof e.id === 'string' && e.id.startsWith('session:') && typeof e.text === 'string' && hash(e.text) === e.hash, 'Invalid session evidence');
      bytes += e.text.length;
      assert(bytes <= config.maxSnapshotBytes, 'Session archive exceeds maxSnapshotBytes; archive processed sessions or raise limit');
      events.set(e.id, e);
    }
  }
  const sorted = [...events.values()].sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  for (const e of sorted) contents.set(e.id, `${e.role}: ${e.text}`);
  return sorted;
}
