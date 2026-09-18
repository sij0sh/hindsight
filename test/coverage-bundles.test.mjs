import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, baseline, put, readAll } from './helpers.mjs';
import { route } from '../src/router.mjs';
import { Investigation } from '../src/investigation.mjs';
import { collect, git } from '../src/collector.mjs';
import { packBundle } from '../src/bundles.mjs';
import { deriveConfidence } from '../src/memory.mjs';
import { hash } from '../src/util.mjs';

const now = '2026-09-18T00:00:00.000Z';
const historyEvidence = (overrides = {}) => ({ type: 'history', ref: 'git:abc123', hash: hash('evidence'), start: 0, end: 8, classification: 'observed', reportPath: 'test-report', at: now, ...overrides });
const outcome = (id, refs = []) => ({ id, outcome: 'no_finding', finding: 'Evidence supports the existing documented behavior.', evidenceRefs: refs, classification: 'observed', confidence: 'high' });
async function forceArch(t, files) {
  const f = await fixture(t, files);
  const { snapshot, state } = await baseline(f);
  const job = route(snapshot, state, f.catalog, f.config, { force: true, domain: 'architecture' })[0];
  return { f, job, inv: new Investigation(job, snapshot, f.config) };
}

test('git collection captures deterministic commit order, messages, and diffs', async t => {
  const f = await fixture(t);
  await put(f.root, 'src/main.ts', 'export const answer = 43;\n');
  await git(f.root, ['add', 'src/main.ts']); await git(f.root, ['commit', '-qm', 'Bump the answer']);
  const snapshot = await collect(f.root, f.config, f.catalog);
  assert.equal(snapshot.git.metadata.head, snapshot.head);
  assert.equal(snapshot.git.commits[0].subject, 'Bump the answer');
  const bump = snapshot.git.commits[0];
  const change = bump.paths.find(p => p.path === 'src/main.ts');
  assert.equal(change.status, 'M');
  assert.equal(change.patchStatus, 'included');
  assert.match(change.patch, /answer = 43/);
  assert.match(bump.text, /Bump the answer/);
  assert.ok(snapshot.contents.has(`git:${bump.oid}`));
  assert.equal(snapshot.git.metadata.historyComplete, true);
});

test('sensitive and excluded historical paths never expose contents', async t => {
  const f = await fixture(t);
  await put(f.root, '.env', 'TOKEN=historical-secret');
  await git(f.root, ['add', '.env']); await git(f.root, ['commit', '-qm', 'Add dotenv']);
  const snapshot = await collect(f.root, f.config, f.catalog);
  const dotenv = snapshot.git.commits[0];
  assert.equal(dotenv.paths.find(p => p.path === '.env').patchStatus, 'withheld_sensitive');
  assert.ok(!dotenv.text.includes('historical-secret'));
  assert.ok(snapshot.git.metadata.omitted.some(o => o.path === '.env' && o.commit === dotenv.oid));
  const { state } = await baseline(f);
  const job = route(snapshot, state, f.catalog, f.config, { force: true, domain: 'security' })[0];
  const inv = new Investigation(job, snapshot, f.config);
  for (const { id } of inv.list().evidence) if (id.startsWith('bundle:git')) assert.ok(!inv.evidence.get(id).includes('historical-secret'));
});

test('oversized patches are explicitly omitted, never silently truncated', async t => {
  const f = await fixture(t);
  const config = { ...f.config, maxGitPatchChars: 10 };
  const snapshot = await collect(f.root, config, f.catalog);
  const first = snapshot.git.commits[0];
  assert.ok(first.paths.some(p => p.patchStatus === 'omitted_too_large'));
  const omitted = first.paths.find(p => p.patchStatus === 'omitted_too_large');
  assert.ok(omitted.patchChars > config.maxGitPatchChars);
  assert.match(first.text, /omitted_too_large/);
});

test('incremental git selection covers baseline to HEAD for the domain surface', async t => {
  const f = await fixture(t);
  const { snapshot, state } = await baseline(f);
  const firstHead = snapshot.head;
  await put(f.root, 'package.json', '{"name":"fixture","version":"1.0.1"}\n');
  await git(f.root, ['add', 'package.json']); await git(f.root, ['commit', '-qm', 'Release 1.0.1']);
  const next = await collect(f.root, f.config, f.catalog);
  const job = route(next, state, f.catalog, f.config, { domain: 'dependencies' })[0];
  assert.equal(job.baselineCommit, firstHead);
  assert.deepEqual(job.gitEvidenceIds, [`git:${next.head}`]);
  assert.equal(job.gitRange, 'delta');
  const inv = new Investigation(job, next, f.config);
  assert.ok(inv.evidence.has('bundle:git'));
  assert.match(inv.evidence.get('bundle:git'), /Release 1\.0\.1/);
  assert.equal(inv.coverage.bundles.git.status, 'available');
});

test('a rewritten baseline becomes explicit divergence with a bounded fallback survey', async t => {
  const f = await fixture(t);
  const { snapshot, state } = await baseline(f);
  state.documents.dependencies.lastCuratedCommit = '0'.repeat(40);
  const job = route(snapshot, state, f.catalog, f.config, { domain: 'dependencies' })[0];
  assert.equal(job.gitRange, 'history_diverged');
  const inv = new Investigation(job, snapshot, f.config);
  assert.equal(inv.coverage.bundles.git.status, 'history_diverged');
  assert.equal(inv.coverage.bundles.git.required, false);
  assert.ok(inv.evidence.has('bundle:git'));
});

test('required git bundle parts must be fully read before submission', async t => {
  const { inv } = await forceArch(t);
  const gitParts = inv.coverage.bundles.git.parts.map(p => p.id);
  assert.ok(gitParts.length > 0);
  const refs = [];
  for (const { id } of inv.list().evidence) if (!id.startsWith('bundle:')) refs.push(readAll(inv, id));
  for (const id of inv.checks.keys()) inv.resolve(outcome(id, refs));
  for (const bundleId of ['bundle:code', 'bundle:prose']) {
    const part = inv.coverage.bundles[bundleId === 'bundle:code' ? 'code' : 'prose'].parts[0]?.id ?? bundleId;
    if (inv.evidence.has(part)) readAll(inv, part);
  }
  assert.throws(() => inv.submit({ summary: 'No canonical changes are required.', memoryOps: {} }), new RegExp(`requires reading ${gitParts[0]} in full`));
  for (const id of gitParts) readAll(inv, id);
  inv.submit({ summary: 'No canonical changes are required.', memoryOps: {} });
  assert.equal(inv.submission.result, 'no_change');
});

test('git bundle receipts are rejected while commits persist as history provenance', async t => {
  const { inv } = await forceArch(t);
  const allRefs = [];
  for (const { id } of inv.list().evidence) allRefs.push(readAll(inv, id));
  const gitPart = inv.coverage.bundles.git.parts[0].id;
  const bundleRef = [...inv.receipts.values()].find(r => r.id === gitPart).ref;
  const gitRef = [...inv.receipts.values()].find(r => r.id.startsWith('git:')).ref;
  const first = [...inv.checks.keys()][0];
  for (const id of inv.checks.keys()) inv.resolve({ ...outcome(id, allRefs), ...(id === first ? { outcome: 'update' } : {}) });
  assert.throws(() => inv.submit({
    summary: 'Attempt bundle-backed durable memory.', memoryOps: { create: [{ kind: 'invariant', domains: ['architecture'], statement: 'History was inspected through a coverage bundle.', scope: { global: true, paths: [], symbols: [], concepts: [] }, checkIds: [first], evidenceRefs: [bundleRef] }] }
  }), /Coverage bundle receipts cannot support durable memory/);
  inv.submit({
    summary: 'Record history-backed knowledge.', memoryOps: { create: [{ kind: 'invariant', domains: ['architecture'], statement: 'The fixture repository was initialized with package metadata.', scope: { global: true, paths: [], symbols: [], concepts: [] }, checkIds: [first], evidenceRefs: [gitRef] }] }
  });
  const record = inv.proposedLedger.records[0];
  assert.equal(record.provenance[0].type, 'history');
  assert.equal(record.confidence, 'inferred');
  assert.equal(record.status, 'unverified');
});

test('history alone never becomes strong or authoritative confidence', () => {
  assert.equal(deriveConfidence([historyEvidence()]), 'inferred');
  assert.equal(deriveConfidence([historyEvidence({ classification: 'decision' })]), 'inferred');
  assert.equal(deriveConfidence([historyEvidence(), { ...historyEvidence(), ref: 'git:def456' }]), 'inferred');
});

test('new history invalidates snapshots without re-routing surface-irrelevant commits', async t => {
  const f = await fixture(t);
  const { snapshot, state } = await baseline(f);
  await git(f.root, ['commit', '--allow-empty', '-qm', 'metadata only']);
  const next = await collect(f.root, f.config, f.catalog);
  assert.notEqual(next.snapshotHash, snapshot.snapshotHash);
  const jobs = route(next, state, f.catalog, f.config);
  assert.ok(jobs.every(j => j.status === 'unchanged'));
  // Same worktree content as the baseline, but new history touching the surface.
  await put(f.root, 'src/main.ts', 'export const answer = 99;\n');
  await git(f.root, ['add', 'src/main.ts']); await git(f.root, ['commit', '-qm', 'change answer']);
  await git(f.root, ['checkout', '-q', 'HEAD~1', '--', 'src/main.ts']);
  const rewritten = await collect(f.root, f.config, f.catalog);
  assert.notEqual(rewritten.snapshotHash, next.snapshotHash);
  assert.notEqual(route(rewritten, state, f.catalog, f.config).find(j => j.domain === 'architecture').status, 'unchanged');
});

test('oversized code bundles shard into deterministic parts with full-read gates', async t => {
  const files = Object.fromEntries([1, 2, 3, 4].map(n => [`src/part${n}.ts`, `export const part${n} = ${n};\n`]));
  const f = await fixture(t, files);
  const config = { ...f.config, maxCoverageBundleChars: 1200, maxCoverageBundleParts: 8 };
  const { snapshot, state } = await baseline(f);
  const job = route(snapshot, state, f.catalog, config, { force: true, domain: 'architecture' })[0];
  const first = new Investigation(job, snapshot, config);
  const code = first.coverage.bundles.code;
  assert.equal(code.status, 'available');
  assert.ok(code.parts.length > 1);
  assert.ok(code.parts.every(p => p.chars <= config.maxCoverageBundleChars));
  assert.ok(code.parts.every(p => p.id.startsWith('bundle:code:')));
  const second = new Investigation(job, snapshot, config);
  assert.deepEqual(second.coverage.bundles.code.parts, code.parts);
  const refs = [];
  for (const { id } of first.list().evidence) if (!id.startsWith('bundle:')) refs.push(readAll(first, id));
  for (const id of first.checks.keys()) first.resolve(outcome(id, refs));
  assert.throws(() => first.submit({ summary: 'No canonical changes are required.', memoryOps: {} }), new RegExp(`requires reading ${code.parts[0].id} in full`));
  for (const part of code.parts) readAll(first, part.id);
  for (const { id } of first.list().evidence) if (id.startsWith('bundle:') && !id.startsWith('bundle:code:')) readAll(first, id);
  first.submit({ summary: 'No canonical changes are required.', memoryOps: {} });
  assert.equal(first.submission.result, 'no_change');
});

test('estimated-fit parts that overflow on render degrade instead of throwing', () => {
  const makeSpec = (items, blobSize) => ({
    kind: 'git', alias: 'bundle:git', countLabel: 'commits', total: items.length, source: 'regression',
    inventory: subset => subset.map(it => ({ oid: it.oid, blob: 'y'.repeat(blobSize) })),
    sections: (item, index) => ({ heading: `## Commit ${index + 1}`, meta: [`- oid: ${JSON.stringify(item.oid)}`], fence: '```', language: 'markdown', text: item.text }),
    items
  });
  const items = [1, 2, 3, 4].map(n => ({ oid: `oid${n}`, text: 'x'.repeat(50) }));
  // Singles fit but estimated groups overflow: re-split into fitting parts.
  const split = packBundle(makeSpec(items, 500), { maxCoverageBundleChars: 1500, maxCoverageBundleParts: 8 });
  assert.equal(split.bundle.status, 'available');
  assert.ok(split.bundle.parts.length > 1);
  assert.ok(split.bundle.parts.every(p => p.chars <= 1500));
  assert.equal(split.evidence.size, split.bundle.parts.length);
  // Even a single item overflows: report unavailable with no throw and no partial evidence.
  const tiny = packBundle(makeSpec(items, 500), { maxCoverageBundleChars: 500, maxCoverageBundleParts: 8 });
  assert.equal(tiny.bundle.status, 'unavailable_too_large');
  assert.equal(tiny.bundle.required, false);
  assert.equal(tiny.evidence.size, 0);
});

test('bundles beyond the part budget report unavailable instead of truncating', async t => {
  const files = Object.fromEntries([1, 2, 3, 4].map(n => [`src/part${n}.ts`, `export const part${n} = ${n};\n`]));
  const f = await fixture(t, files);
  const config = { ...f.config, maxCoverageBundleChars: 1200, maxCoverageBundleParts: 1 };
  const { snapshot, state } = await baseline(f);
  const job = route(snapshot, state, f.catalog, config, { force: true, domain: 'architecture' })[0];
  const inv = new Investigation(job, snapshot, config);
  assert.equal(inv.coverage.bundles.code.status, 'unavailable_too_large');
  assert.equal(inv.coverage.bundles.code.required, false);
  assert.equal(inv.evidence.has('bundle:code'), false);
  assert.equal(inv.evidence.has('bundle:code:001'), false);
});
