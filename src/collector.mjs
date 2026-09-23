import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readlink, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assert, hash, matches, optionalRead, safePath, readJson, writeJson } from './util.mjs';
import { loadLedger, scarSignals, MEMORY_PATH } from './memory.mjs';
import { normalizePiSession, buildEpisodes, sanitizeUserText, SESSION_POLICY } from './session-normalizer.mjs';
import { MUSE_POLICY } from './muse-adapter.mjs';
import { CLAUDE_POLICY } from './claude-adapter.mjs';
import { GIT_POLICY, renderCommitEvidence, hashCommit } from './git-evidence.mjs';

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
  const charge = text => { bytes += Buffer.byteLength(text); assert(bytes <= config.maxSnapshotBytes, 'Repository exceeds maxSnapshotBytes; adjust configuration'); };
  const gitHistory = await collectGitHistory(root, config, head, charge);
  for (const commit of gitHistory.commits) contents.set(`git:${commit.oid}`, commit.text);
  const ledger=await loadLedger(root,config);
  const ledgerText=await optionalRead(await safePath(root,MEMORY_PATH));
  assert((ledger===null&&ledgerText===null)||(ledger!==null&&ledgerText!==null&&hash(JSON.parse(ledgerText))===hash(ledger)),'Memory ledger changed while collecting; retry');
  if(ledger) {
    contents.set('memory-index',JSON.stringify(ledger.records.map(({id,kind,domains,statement,scope,status,confidence})=>({id,kind,domains,statement,scope,status,confidence})),null,2));
    for(const record of ledger.records)contents.set(`memory:${record.id}`,JSON.stringify(record,null,2));
    const archives=new Set(ledger.records.filter(r=>r.migration?.scopeNeedsReview&&['unverified','conflicted'].includes(r.status)).map(r=>r.migration.backupPath));
    for(const path of archives) {
      const archive=ledger.imports.find(i=>i.backupPath===path);
      assert(archive,'Imported memory is missing its archive reference');
      const text=await optionalRead(await safePath(root,path));
      assert(text!==null&&hash(text)===archive.hash,`Migration archive is missing or changed: ${path}`);
      bytes+=Buffer.byteLength(text);assert(bytes<=config.maxSnapshotBytes,'Migration archives exceed maxSnapshotBytes');
      contents.set(`archive:${path}`,text);
    }
  }
  const snapshotHash = hash({ files: Object.fromEntries(Object.entries(files).map(([p, f]) => [p, f.hash])), sessions: Object.fromEntries(sessions.events.map(s => [s.id, s.hash])), sessionEpisodes: Object.fromEntries(sessions.episodes.map(e => [e.id, e.hash])), git: Object.fromEntries(gitHistory.commits.map(c => [c.oid, c.hash])), churn });
  return { root, head, files, documents, sessions: sessions.events, sessionEpisodes: sessions.episodes, git: gitHistory, contents, churn, snapshotHash,ledger,ledgerHash:ledgerText===null?null:hash(ledgerText),scarSignals:scarSignals(ledger,files) };
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
const archivePathOf = sessionId => `.agents/curation/sessions/${hash(sessionId).slice(7)}.json`;
/**
 * Merge normalized atomics into the session archive. Returns counts plus the
 * text size of new or changed atomics, which importers charge against their budget.
 */
export async function captureSession(root, sessionId, entries, { source = 'pi', policy = SESSION_POLICY } = {}) {
  const { atomicEvidence } = normalizePiSession(sessionId, entries, { source, root });
  // Merge branches by stable entry identity; do not erase previously captured evidence.
  const path = archivePathOf(sessionId);
  const old = await readJson(root, path, { events: [] });
  const prior = Array.isArray(old.events) ? old.events : [];
  const merged = new Map(prior.map(e => [e.id, e]));
  let added = 0, changed = 0, chars = 0;
  for (const e of atomicEvidence) {
    const stored = merged.get(e.id);
    // A capture taken before the result arrived must not erase a recorded outcome.
    if (stored?.tool?.outcome && !e.tool?.outcome) continue;
    if (stored?.hash === e.hash) continue;
    if (stored) changed += 1; else added += 1;
    chars += e.text.length;
    merged.set(e.id, e);
  }
  if (!added && !changed) return { added, changed, chars };
  const sorted = [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  await writeJson(root, path, { version: 2, normalizationPolicy: policy, source, sessionId, events: sorted, episodes: buildEpisodes(sessionId, sorted, { source }) });
  return { added, changed, chars };
}
export async function captureMuseSession(root, sessionId, entries) {
  return captureSession(root, sessionId, entries, { source: 'muse', policy: MUSE_POLICY });
}
export async function captureClaudeSession(root, sessionId, entries) {
  return captureSession(root, sessionId, entries, { source: 'claude', policy: CLAUDE_POLICY });
}
async function sessionArchives(root) {
  const dir = await safePath(root, '.agents/curation/sessions');
  let paths = [];
  try { paths = await readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return paths.filter(p => p.endsWith('.json')).sort().map(p => `.agents/curation/sessions/${p}`);
}
/** Stored atomic text size; importers keep it well under maxSnapshotBytes so collect never fails on growth. */
export async function sessionArchiveChars(root) {
  let chars = 0;
  for (const path of await sessionArchives(root)) {
    const data = await readJson(root, path);
    for (const e of Array.isArray(data?.events) ? data.events : []) if (typeof e?.text === 'string') chars += e.text.length;
  }
  return chars;
}
function sessionIdOfArchive(data, path) {
  if (typeof data.sessionId === 'string' && data.sessionId) return data.sessionId;
  // Version-1 archives predate explicit session IDs; infer from legacy event IDs.
  for (const e of data.events ?? []) {
    const match = /^session:([^:]+):/.exec(e.id ?? '');
    if (match) return match[1];
  }
  throw new Error(`Invalid session inventory ${path}`);
}
async function collectSessions(root, contents, config) {
  const events = new Map(), bySession = new Map(), sources = new Map(); let bytes = 0;
  for (const path of await sessionArchives(root)) {
    const data = await readJson(root, path);
    assert(data && Array.isArray(data.events), `Invalid session inventory ${path}`);
    const sessionId = sessionIdOfArchive(data, path);
    sources.set(sessionId, typeof data.source === 'string' ? data.source : 'pi');
    for (const stored of data.events) {
      assert(typeof stored.id === 'string' && stored.id.startsWith('session:') && typeof stored.text === 'string' && hash(stored.text) === stored.hash, 'Invalid session evidence');
      assert(['user', 'assistant', 'tool'].includes(stored.role), 'Invalid session evidence role');
      if (stored.tool !== undefined) assert(stored.tool && typeof stored.tool === 'object' && typeof stored.tool.name === 'string', 'Invalid session tool evidence');
      // Archives captured before the sanitizer existed may hold injected wrappers in user turns.
      const text = stored.role === 'user' ? sanitizeUserText(stored.text) : stored.text;
      if (!text) continue;
      const e = text === stored.text ? stored : { ...stored, text, hash: hash(text) };
      bytes += e.text.length;
      assert(bytes <= config.maxSnapshotBytes, 'Session archive exceeds maxSnapshotBytes; archive processed sessions or raise limit');
      events.set(e.id, e);
      if (!bySession.has(sessionId)) bySession.set(sessionId, new Map());
      bySession.get(sessionId).set(e.id, e);
    }
  }
  const sorted = [...events.values()].sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  for (const e of sorted) contents.set(e.id, `${e.role}: ${e.text}`);
  // Episodes are rebuilt from atomic events on every collection, so version-1
  // archives (which discarded tool calls at capture time) yield episodes from
  // the user/assistant evidence they actually contain. Recapturing the
  // original JSONL upgrades the stored session with richer episodes.
  const episodes = [];
  for (const [sessionId, sessionMap] of [...bySession.entries()].sort(([a],[b]) => a < b ? -1 : 1)) {
    const sessionSorted = [...sessionMap.values()].sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
    for (const episode of buildEpisodes(sessionId, sessionSorted, { source: sources.get(sessionId) })) {
      bytes += episode.text.length;
      assert(bytes <= config.maxSnapshotBytes, 'Session archive exceeds maxSnapshotBytes; archive processed sessions or raise limit');
      episodes.push(episode);
    }
  }
  episodes.sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  return { events: sorted, episodes };
}

/**
 * Bounded commit/message/diff collection. Historical material passes the
 * same exclusion, sensitivity, generated-path, binary, and size filtering as
 * working-tree evidence; withheld patches are reported, never exposed.
 */
export async function collectGitHistory(root, config, head, charge = () => {}) {
  const metadata = { head, policy: GIT_POLICY, boundedBy: config.maxGitHistoryCommits, commitsIncluded: 0, historyComplete: true, oldestIncluded: null, omitted: [] };
  if (!head) return { commits: [], metadata };
  const total = Number((await git(root, ['rev-list', '--count', 'HEAD'])).trim());
  const oids = (await git(root, ['rev-list', `--max-count=${config.maxGitHistoryCommits}`, 'HEAD'])).trim().split('\n').filter(Boolean);
  metadata.commitsIncluded = oids.length;
  metadata.historyComplete = total <= oids.length;
  metadata.oldestIncluded = oids.at(-1) ?? null;
  const emptyTree = (await git(root, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
  const commits = [];
  for (const oid of oids) {
    const [parentsRaw = '', committedAt = '0', subject = '', body = ''] = (await git(root, ['show', '-s', '--format=%P%x00%ct%x00%s%x00%b%x00', oid])).split('\0');
    const parents = parentsRaw.trim().split(/\s+/).filter(Boolean);
    const timestamp = new Date(Number(committedAt.trim()) * 1000).toISOString();
    const message = body.trim();
    charge(message);
    const base = parents[0] ?? emptyTree;
    const statusRaw = await git(root, ['diff', '--name-status', '-z', base, oid, '--']);
    const tokens = statusRaw.split('\0').filter(Boolean);
    const paths = [];
    for (let i = 0; i < tokens.length; i++) {
      const statusToken = tokens[i];
      let path = tokens[++i];
      if (/^[CR]/.test(statusToken)) path = tokens[++i] ?? path;
      if (path === undefined) break;
      const status = statusToken[0];
      const withheld = generated(path) ? 'withheld_generated' : matches(config.exclude, path) ? 'withheld_excluded' : isSensitive(path, config) ? 'withheld_sensitive' : null;
      if (withheld) {
        metadata.omitted.push({ commit: oid, path, reason: withheld === 'withheld_sensitive' ? 'sensitive input' : withheld === 'withheld_excluded' ? 'excluded input' : 'generated input' });
        paths.push({ path, status, patchStatus: withheld, patchChars: 0 });
        continue;
      }
      const patch = await git(root, ['diff', '--no-color', '--no-ext-diff', base, oid, '--', path]);
      if (patch.includes('\0')) {
        metadata.omitted.push({ commit: oid, path, reason: 'binary input' });
        paths.push({ path, status, patchStatus: 'withheld_binary', patchChars: 0 });
        continue;
      }
      if (patch.length > config.maxGitPatchChars) {
        metadata.omitted.push({ commit: oid, path, reason: 'patch exceeds maxGitPatchChars' });
        paths.push({ path, status, patchStatus: 'omitted_too_large', patchChars: patch.length });
        continue;
      }
      charge(patch);
      paths.push({ path, status, patchStatus: 'included', patchChars: patch.length, patch });
    }
    const hashValue = hashCommit({ oid, timestamp, parents, subject, message, paths });
    const commit = { oid, timestamp, parents, subject, message, paths, hash: hashValue };
    commit.text = renderCommitEvidence(commit);
    charge(commit.text);
    commits.push(commit);
  }
  return { commits, metadata };
}
