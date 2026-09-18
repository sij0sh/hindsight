import { extname, basename } from 'node:path';
import { hash } from './util.mjs';

const PROSE_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc', '.asciidoc']);
const PROSE_BASENAMES = /^(?:readme|changelog|contributing|authors|notice|license)(?:\.|$)/i;
const LANGUAGES = new Map([
  ['.c','c'],['.cc','cpp'],['.cpp','cpp'],['.cxx','cpp'],['.h','c'],['.hpp','cpp'],
  ['.cs','csharp'],['.go','go'],['.java','java'],['.js','javascript'],['.jsx','javascript'],
  ['.mjs','javascript'],['.cjs','javascript'],['.json','json'],['.jsonc','json'],['.kt','kotlin'],
  ['.php','php'],['.py','python'],['.rb','ruby'],['.rs','rust'],['.sh','bash'],['.bash','bash'],
  ['.sql','sql'],['.toml','toml'],['.ts','typescript'],['.tsx','typescript'],['.yaml','yaml'],['.yml','yaml'],
  ['.xml','xml'],['.html','html'],['.css','css'],['.scss','scss']
]);

export function isProsePath(path) {
  const lower = path.toLowerCase();
  return PROSE_EXTENSIONS.has(extname(lower)) || PROSE_BASENAMES.test(basename(lower));
}

function fenceFor(content) {
  let longest = 0, run = 0;
  for (const ch of content) {
    if (ch === '`') { run++; longest = Math.max(longest, run); }
    else run = 0;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

function languageFor(path, kind) {
  if (kind === 'prose') return extname(path).toLowerCase() === '.md' || extname(path).toLowerCase() === '.mdx' ? 'markdown' : 'text';
  return LANGUAGES.get(extname(path).toLowerCase()) ?? '';
}

const PROVENANCE_NOTES = {
  code: 'Durable memory operations must cite the original atomic evidence ID named for the relevant file, not this bundle.',
  prose: 'Durable memory operations must cite the original atomic evidence ID named for the relevant file, not this bundle.',
  sessions: 'Durable memory operations must cite the original atomic session evidence ID named for the relevant message, not this bundle.',
  git: 'Durable memory operations must cite the original atomic git evidence ID named for the relevant commit, not this bundle.'
};

/**
 * Render one bundle part. A logical bundle is a deterministic sequence of
 * sections; small bundles keep a single part under the friendly alias
 * (bundle:code), while larger ones shard into numbered parts
 * (bundle:sessions:001, ...) at item boundaries. An item is never split.
 */
function renderPart({ kind, countLabel, total, source, inventory, sections, subset, part, parts }) {
  const lines = [
    `# Hindsight ${kind} coverage bundle`,
    '',
    '> Coverage evidence only. This bundle is for deterministic repository survey and navigation.',
    `> ${PROVENANCE_NOTES[kind]}`,
    '',
    `- kind: ${kind}`,
    `- ${countLabel}: ${total}`,
    ...(parts > 1 ? [`- part: ${part} of ${parts}`] : []),
    `- source: ${source}`,
    '',
    '## Inventory',
    '',
    '```json',
    JSON.stringify(inventory(subset), null, 2),
    '```',
    ''
  ];
  subset.forEach((item, index) => {
    const section = sections(item, index);
    lines.push(section.heading, '', ...section.meta, '', `${section.fence}${section.language}`, section.text.replace(/\n$/, ''), section.fence, '');
  });
  return `${lines.join('\n')}\n`;
}

function fileSection(kind) {
  return ({ path, id, text }, index) => ({
    heading: `## File ${index + 1}`,
    meta: [
      `- path: ${JSON.stringify(path)}`,
      `- evidence-id: ${JSON.stringify(id)}`,
      `- content-sha256: ${JSON.stringify(hash(text))}`,
      `- chars: ${text.length}`
    ],
    fence: fenceFor(text),
    language: languageFor(path, kind),
    text
  });
}

/**
 * Pack bundle items into deterministic parts. Returns virtual evidence plus
 * bundle metadata. Oversized or over-sharded bundles report their size
 * honestly instead of truncating or pretending to be complete.
 */
export function packBundle(spec, config) {
  const { kind, alias, countLabel, total, items } = spec;
  const empty = { id: alias, status: 'empty', required: false, [countLabel]: 0, chars: 0, parts: [] };
  if (!items.length) return { evidence: new Map(), bundle: empty };
  const maxChars = config.maxCoverageBundleChars;
  const maxParts = config.maxCoverageBundleParts;
  const single = renderPart({ ...spec, subset: items, part: 1, parts: 1 });
  if (single.length <= maxChars) {
    return {
      evidence: new Map([[alias, single]]),
      bundle: { id: alias, status: 'available', required: true, [countLabel]: total, chars: single.length, hash: hash(single), parts: [{ id: alias, chars: single.length, hash: hash(single) }] }
    };
  }
  // Shard at item boundaries. A part holds as many whole items as fit.
  const overhead = renderPart({ ...spec, subset: [], part: 1, parts: 2 }).length;
  const groups = [];
  let current = [], currentChars = overhead;
  const sectionChars = items.map(item => {
    const section = spec.sections(item, 0);
    return `${section.heading}${section.meta.join('')}${section.text}`.length + overhead;
  });
  for (let i = 0; i < items.length; i++) {
    if (sectionChars[i] + overhead > maxChars) {
      return { evidence: new Map(), bundle: { id: alias, status: 'unavailable_too_large', required: false, [countLabel]: total, chars: single.length, maxChars } };
    }
    if (current.length && currentChars + sectionChars[i] > maxChars) { groups.push(current); current = []; currentChars = overhead; }
    current.push(items[i]); currentChars += sectionChars[i];
  }
  if (current.length) groups.push(current);
  if (groups.length > maxParts) {
    return { evidence: new Map(), bundle: { id: alias, status: 'unavailable_too_large', required: false, [countLabel]: total, chars: single.length, maxChars, partsNeeded: groups.length, maxParts } };
  }
  const evidence = new Map(), parts = [];
  groups.forEach((subset, index) => {
    const id = `${alias}:${String(index + 1).padStart(3, '0')}`;
    const text = renderPart({ ...spec, subset, part: index + 1, parts: groups.length });
    if (text.length > maxChars) {
      throw new Error(`Bundle sharding exceeded the per-part budget: ${id}`);
    }
    evidence.set(id, text);
    parts.push({ id, chars: text.length, hash: hash(text) });
  });
  const chars = parts.reduce((n, p) => n + p.chars, 0);
  return { evidence, bundle: { id: alias, status: 'available', required: true, [countLabel]: total, chars, hash: hash(parts.map(p => p.hash)), parts } };
}

function codeBundleSpec(entries) {
  return {
    kind: 'code', alias: 'bundle:code', countLabel: 'files', total: entries.length,
    source: 'current readable working-tree snapshot',
    inventory: subset => subset.map(({ path, id, text }) => ({ path, evidenceId: id, chars: text.length, contentHash: hash(text) })),
    sections: fileSection('code'),
    items: entries
  };
}

function proseBundleSpec(entries) {
  return { ...codeBundleSpec(entries), kind: 'prose', alias: 'bundle:prose', sections: fileSection('prose') };
}

export function sessionBundleSpec(episodes) {
  return {
    kind: 'sessions', alias: 'bundle:sessions', countLabel: 'episodes', total: episodes.length,
    source: 'normalized Pi session episodes (policy pi-session-episode-v1); raw tool-result bodies are excluded',
    inventory: subset => subset.map(episode => ({ episodeId: episode.id, timestamp: episode.timestamp, eventIds: episode.eventIds, paths: episode.paths, chars: episode.text.length, contentHash: episode.hash })),
    sections: (episode, index) => ({
      heading: `## Episode ${index + 1}`,
      meta: [
        `- episode-id: ${JSON.stringify(episode.id)}`,
        `- timestamp: ${JSON.stringify(episode.timestamp)}`,
        `- events: ${JSON.stringify(episode.eventIds)}`,
        `- paths: ${JSON.stringify(episode.paths)}`,
        `- content-sha256: ${JSON.stringify(episode.hash)}`,
        `- chars: ${episode.text.length}`
      ],
      fence: fenceFor(episode.text),
      language: 'markdown',
      text: episode.text
    }),
    items: episodes
  };
}

export function gitBundleSpec(commits, { range }) {
  return {
    kind: 'git', alias: 'bundle:git', countLabel: 'commits', total: commits.length,
    source: `bounded commit history (policy git-evidence-v1; range ${range})`,
    inventory: subset => subset.map(commit => ({ oid: commit.oid, evidenceId: `git:${commit.oid}`, timestamp: commit.timestamp, subject: commit.subject, paths: commit.paths.map(c => c.path), chars: commit.text.length, contentHash: commit.hash })),
    sections: (commit, index) => ({
      heading: `## Commit ${index + 1}`,
      meta: [
        `- oid: ${JSON.stringify(commit.oid)}`,
        `- evidence-id: ${JSON.stringify(`git:${commit.oid}`)}`,
        `- timestamp: ${JSON.stringify(commit.timestamp)}`,
        `- subject: ${JSON.stringify(commit.subject)}`,
        `- content-sha256: ${JSON.stringify(commit.hash)}`,
        `- chars: ${commit.text.length}`
      ],
      fence: fenceFor(commit.text),
      language: 'markdown',
      text: commit.text
    }),
    items: commits
  };
}

/**
 * Build deterministic virtual evidence from the immutable collector snapshot.
 * Bundles are created only from captured snapshot state and never reread the
 * filesystem. Code/prose bundles cover complete-survey jobs; session and git
 * bundles cover the job's pending episodes and selected history range.
 */
export function buildCoverageBundles(snapshot, job, config) {
  const coverageRequired = Boolean(job.coverageRequired);
  const readable = Object.keys(snapshot.files).sort().flatMap(path => {
    const id = `file:${path}`;
    const text = snapshot.contents.get(id);
    return text === undefined ? [] : [{ path, id, text }];
  });
  const unavailable = Object.entries(snapshot.files).filter(([, file]) => file.unreadable || file.missing).map(([path, file]) => ({ path, reason: file.unreadable ?? 'missing' }));
  const groups = {
    code: readable.filter(entry => !isProsePath(entry.path)),
    prose: readable.filter(entry => isProsePath(entry.path))
  };
  const evidence = new Map(), bundles = {};
  for (const kind of ['code', 'prose']) {
    const spec = kind === 'code' ? codeBundleSpec(groups.code) : proseBundleSpec(groups.prose);
    if (!coverageRequired) {
      bundles[kind] = { id: spec.alias, status: 'not_required', required: false, [spec.countLabel]: spec.total, parts: [] };
      continue;
    }
    const packed = packBundle(spec, config);
    if (packed.bundle.status !== 'available') packed.bundle.required = false;
    bundles[kind] = packed.bundle;
    for (const [id, text] of packed.evidence) evidence.set(id, text);
  }
  const sessionEpisodes = Array.isArray(job.sessionBatch) ? job.sessionBatch.filter(e => e && typeof e.id === 'string' && e.id.startsWith('episode:')) : [];
  if (!sessionEpisodes.length) {
    bundles.sessions = { id: 'bundle:sessions', status: 'empty', required: false, episodes: 0, chars: 0, parts: [] };
  } else {
    const packed = packBundle(sessionBundleSpec(sessionEpisodes), config);
    if (packed.bundle.status !== 'available') packed.bundle.required = false;
    bundles.sessions = packed.bundle;
    for (const [id, text] of packed.evidence) evidence.set(id, text);
  }
  const gitSelection = selectGitBundleCommits(snapshot, job);
  if (gitSelection.status === 'empty' || !gitSelection.commits.length) {
    bundles.git = { id: 'bundle:git', status: gitSelection.status === 'history_diverged' ? 'history_diverged' : 'empty', required: false, commits: 0, chars: 0, parts: [], ...(gitSelection.status === 'history_diverged' ? { baselineCommit: job.baselineCommit ?? null, currentCommit: job.currentCommit ?? snapshot.head } : {}) };
  } else {
    const packed = packBundle(gitBundleSpec(gitSelection.commits, { range: gitSelection.range }), config);
    if (packed.bundle.status !== 'available') packed.bundle.required = false;
    else if (gitSelection.status === 'history_diverged') { packed.bundle.status = 'history_diverged'; packed.bundle.required = false; }
    bundles.git = { ...packed.bundle, range: gitSelection.range, baselineCommit: job.baselineCommit ?? null, currentCommit: job.currentCommit ?? snapshot.head };
    for (const [id, text] of packed.evidence) evidence.set(id, text);
  }
  return {
    evidence,
    metadata: {
      required: coverageRequired,
      scope: 'all collector-approved readable current working-tree files',
      bundles,
      readableFiles: readable.length,
      unavailableFiles: unavailable
    }
  };
}

function selectGitBundleCommits(snapshot, job) {
  const all = Array.isArray(snapshot.git?.commits) ? snapshot.git.commits : [];
  if (!all.length) return { status: 'empty', commits: [] };
  if (job.coverageRequired || job.gitRange === 'all') return { status: 'complete', range: `bounded recent history ending at ${snapshot.head}`, commits: all };
  // Incremental jobs reuse the router's deterministic range selection.
  const wanted = new Set(job.gitEvidenceIds ?? []);
  const commits = all.filter(c => wanted.has(`git:${c.oid}`));
  if (!commits.length) return { status: job.gitRange === 'history_diverged' ? 'history_diverged' : 'empty', commits: [] };
  if (job.gitRange === 'history_diverged') return { status: 'history_diverged', range: `bounded recent history ending at ${job.currentCommit ?? snapshot.head} (baseline ${job.baselineCommit} is not an ancestor)`, commits };
  return { status: 'delta', range: `${job.baselineCommit}..${job.currentCommit ?? snapshot.head}`, commits };
}
