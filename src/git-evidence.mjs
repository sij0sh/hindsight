import { hash } from './util.mjs';

/** Serialization policy version. Included in content hashes so a policy change re-pends evidence. */
export const GIT_POLICY = 'git-evidence-v1';

function fenceFor(content) {
  let longest = 0, run = 0;
  for (const ch of content) {
    if (ch === '`') { run++; longest = Math.max(longest, run); }
    else run = 0;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Deterministic serialization of one commit (§12). Oversized or withheld
 * patches are described explicitly and never silently truncated.
 */
export function renderCommitEvidence(commit) {
  const lines = [
    `# Commit ${commit.oid}`,
    '',
    `timestamp: ${commit.timestamp}`,
    `parents: ${commit.parents.length ? commit.parents.join(' ') : 'none'}`,
    `subject: ${commit.subject}`,
    '',
    '## Message',
    '',
    commit.message.trim() ? commit.message.replace(/\n$/, '') : '(empty message)',
    '',
    '## Changes',
    ''
  ];
  if (!commit.paths.length) lines.push('(no file changes)', '');
  for (const change of commit.paths) {
    lines.push(`### ${change.status} ${change.path}`, '');
    if (change.patchStatus === 'included') {
      lines.push('```diff', change.patch.replace(/\n$/, ''), '```', '');
    } else if (change.patchStatus === 'omitted_too_large') {
      lines.push('patch-status: omitted_too_large', `patch-chars: ${change.patchChars}`, '');
    } else {
      lines.push(`patch-status: ${change.patchStatus}`, `patch-chars: ${change.patchChars ?? 0}`, '');
    }
  }
  return `${lines.join('\n')}\n`;
}

export function hashCommit({ oid, timestamp, parents, subject, message, paths }) {
  return hash({
    policy: GIT_POLICY, oid, timestamp, parents, subject, message,
    changes: paths.map(c => c.patchStatus === 'included'
      ? { path: c.path, status: c.status, patch: c.patch }
      : { path: c.path, status: c.status, patchStatus: c.patchStatus, patchChars: c.patchChars ?? 0 })
  });
}

export function filterBySurface(commits, surfacePaths) {
  if (!surfacePaths?.size) return [];
  return commits.filter(commit => commit.paths.some(c => surfacePaths.has(c.path)));
}

/**
 * Select the immutable commit range baselineOid..headOid by walking
 * first-parent ancestry within the captured window. A baseline that is not
 * reachable means history was rewritten or aged out of the bounded window;
 * report divergence instead of pretending to have a continuous delta.
 */
export function selectGitRange(allCommits, baselineOid, headOid) {
  if (!allCommits.length || !headOid) return { status: 'empty', commits: [] };
  if (baselineOid === headOid) return { status: 'empty', commits: [] };
  if (baselineOid == null) return { status: 'all', commits: allCommits };
  const byOid = new Map(allCommits.map(c => [c.oid, c]));
  const range = [];
  const seen = new Set();
  let oid = headOid, diverged = false;
  while (oid && oid !== baselineOid && !seen.has(oid)) {
    seen.add(oid);
    const commit = byOid.get(oid);
    if (!commit) { diverged = true; break; }
    range.push(commit);
    oid = commit.parents[0] ?? null;
  }
  if (oid !== baselineOid) diverged = true;
  if (!range.length) return { status: diverged ? 'history_diverged' : 'empty', commits: [] };
  if (diverged) return { status: 'history_diverged', commits: range };
  return { status: 'delta', commits: range };
}
