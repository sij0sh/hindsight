import { hash, matches, stable } from './util.mjs';
import { memoryFingerprint, openConflicts } from './memory.mjs';
import { selectGitRange, filterBySurface } from './git-evidence.mjs';

export function route(snapshot, state, catalog, config, { force = false, domain } = {}) {
  return catalog.documents.filter(doc => !domain || doc.id === domain).map(doc => {
    const previous = state.documents?.[doc.id];
    const memories=(snapshot.ledger?.records??[]).filter(r=>r.domains.includes(doc.id)&&['active','unverified','conflicted'].includes(r.status));
    const evidencePaths=memories.flatMap(r=>[...r.scope.paths,...r.provenance.filter(p=>/^(file|index|head):/.test(p.ref)).map(p=>p.ref.slice(p.ref.indexOf(':')+1))]);
    const surface = Object.fromEntries(Object.entries(snapshot.files).filter(([p]) => matches([...doc.inputPaths,...evidencePaths], p)));
    const changed = [...new Set([...Object.keys(surface), ...Object.keys(previous?.files ?? {})])].filter(p => surface[p]?.hash !== previous?.files?.[p]?.hash).sort();
    const usesSessions=doc.sessions||force||memories.some(r=>r.provenance.some(p=>p.type==='session'));
    const acknowledgedEpisodes = previous?.sessionEpisodes ?? {};
    const pendingEpisodes = usesSessions ? (snapshot.sessionEpisodes ?? []).filter(e => acknowledgedEpisodes[e.id] !== e.hash) : [];
    let chars = 0;
    const sessionBatch = [];
    for (const episode of pendingEpisodes) {
      if (sessionBatch.length && chars + episode.text.length > config.maxSessionBatchChars) break;
      // An oversized single episode stays pending; it is never silently truncated/acknowledged.
      if (episode.text.length > config.maxSessionBatchChars) break;
      sessionBatch.push(episode); chars += episode.text.length;
    }
    const sessionEvidenceIds = [...new Set(sessionBatch.flatMap(e => e.eventIds))];
    const atomicById = new Map(snapshot.sessions.map(s => [s.id, s]));
    const sessionEvidence = sessionEvidenceIds.map(id => ({ id, hash: atomicById.get(id)?.hash ?? hash(id), role: atomicById.get(id)?.role ?? 'unknown' }));
    const documentHash = snapshot.documents[doc.id].hash;
    const domainMemoryFingerprint=memoryFingerprint(snapshot.ledger,doc.id);
    const conflicts=openConflicts(snapshot.ledger,doc.id).map(r=>({id:r.id,statement:r.statement,targets:r.conflict.targets}));
    const removalCandidates=(snapshot.scarSignals??[]).filter(s=>s.domains.includes(doc.id)&&s.satisfied);
    const scarFingerprint=hash((snapshot.scarSignals??[]).filter(s=>s.domains.includes(doc.id)));
    const ruleFingerprint = hash({ doc, common: catalog.common, config });
    const relevantChurn = doc.id === 'maintainability' ? Object.fromEntries(Object.entries(snapshot.churn).filter(([p,n]) => p in surface && n >= config.churnThreshold)) : {};
    const surfacePaths = new Set(Object.keys(surface));
    // The git fingerprint covers the bounded window selection for this
    // domain's surface, not the baseline-anchored delta, so acknowledging a
    // run does not itself change the fingerprint on the next inspection.
    const gitWindow = filterBySurface(snapshot.git?.commits ?? [], surfacePaths);
    const rangeSelection = selectGitRange(snapshot.git?.commits ?? [], previous?.lastCuratedCommit ?? null, snapshot.head);
    const inputFingerprint = hash({ files: Object.fromEntries(Object.entries(surface).map(([p,f]) => [p,f.hash])), sessions: usesSessions ? snapshot.sessions.map(s => [s.id, s.hash]) : [], sessionEpisodes: usesSessions ? (snapshot.sessionEpisodes ?? []).map(e => [e.id, e.hash]) : [], git: gitWindow.map(c => [c.oid, c.hash]), churn: relevantChurn });
    const signals = {
      session: pendingEpisodes.length > 0,
      imports: changed.some(p => stable(surface[p]?.features?.imports ?? []) !== stable(previous?.files?.[p]?.features?.imports ?? [])),
      execution: changed.some(p => stable(surface[p]?.features?.execution ?? []) !== stable(previous?.files?.[p]?.features?.execution ?? [])),
      security: changed.some(p => stable(surface[p]?.features?.security ?? []) !== stable(previous?.files?.[p]?.features?.security ?? [])),
      maintenance: changed.some(p => (surface[p]?.features?.lines ?? 0) > 800 || (surface[p]?.features?.todos ?? 0) > (previous?.files?.[p]?.features?.todos ?? 0)),
      churn: Object.keys(relevantChurn).length > 0 && hash(relevantChurn) !== previous?.churnHash
    };
    const triggers = doc.rules.filter(rule => changed.some(p => matches(rule.paths, p)) || rule.signal && signals[rule.signal]).map(rule => ({ id: rule.id, level: rule.level, files: changed.filter(p => matches(rule.paths, p)), checks: rule.checks, ...(rule.signal ? { signal: rule.signal } : {}) }));
    if(snapshot.ledger&&previous&&previous.memoryFingerprint!==domainMemoryFingerprint)triggers.push({id:'memory-ledger-changed',level:'affected',checks:[]});
    if(conflicts.length)triggers.push({id:'open-memory-conflict',level:'affected',checks:[]});
    if(removalCandidates.length&&previous?.scarFingerprint!==scarFingerprint)triggers.push({id:'scar-removal-review',level:'affected',checks:[]});
    let status = 'unchanged';
    if (documentHash === null) status = 'missing';
    else if (force) status = 'force';
    else if (!previous || previous.ruleFingerprint !== ruleFingerprint) status = 'candidate';
    else if (triggers.some(t => t.level === 'affected')) status = 'affected';
    else if (inputFingerprint !== previous.inputFingerprint || documentHash !== previous.documentFingerprint || triggers.length) status = 'candidate';
    if (!previous) triggers.unshift({ id: 'initial-reconciliation', level: 'affected', checks: [] });
    else if (previous.ruleFingerprint !== ruleFingerprint) triggers.unshift({ id: 'rule-version-changed', level: 'affected', checks: [] });
    if (previous && documentHash !== previous.documentFingerprint) triggers.push({ id: 'manual-document-change', level: 'candidate', checks: [] });
    // Missing, forced, or changed catalog/config receives the entire domain catalog.
    const full = ['missing','force'].includes(status) || !previous || previous.ruleFingerprint !== ruleFingerprint;
    const ids = new Set(full ? doc.criteria.map(c => c.id) : [...doc.baseline, ...triggers.flatMap(t => t.checks)]);
    // Fallback surface change not matched by a named trigger must still be investigated.
    if (status === 'candidate' && triggers.length === 0) doc.criteria.forEach(c => ids.add(c.id));
    const checks = [...doc.criteria.filter(c => ids.has(c.id)), ...catalog.common].map(c => ({ ...c, required: true, status: 'pending' }));
    if(snapshot.ledger)checks.push({id:'MEMORY-RECONCILE-001',question:'Are claims atomic, scoped, non-duplicated, evidence-backed, and reconciled with existing memories, conflicts, and scar removal conditions?',required:true,status:'pending'});
    const signature = hash({ inputFingerprint, documentHash, ruleFingerprint, force,memoryFingerprint:domainMemoryFingerprint,scarFingerprint });
    const gitOids = full
      ? gitWindow.map(c => `git:${c.oid}`)
      : rangeSelection.status === 'delta'
        ? rangeSelection.commits.filter(c => c.paths.some(p => surfacePaths.has(p.path))).map(c => `git:${c.oid}`)
        : rangeSelection.status === 'history_diverged'
          ? gitWindow.map(c => `git:${c.oid}`)
          : [];
    return { domain: doc.id, document: doc.path, status, routing: status === 'unchanged' ? 'skip' : 'inspect', triggers, changedFiles: changed, coverageRequired:full, checks, inputFingerprint, ruleFingerprint, documentHash, signature, surface, sessionBatch, sessionEvidenceIds, sessionEvidence, gitEvidenceIds: gitOids, gitRange: rangeSelection.status, pendingSessions: pendingEpisodes.length, sessionBlocked: pendingEpisodes.length > 0 && sessionBatch.length === 0, churnHash: hash(relevantChurn), baselineCommit: previous?.lastCuratedCommit ?? null, currentCommit: snapshot.head,memoryFingerprint:domainMemoryFingerprint,scarFingerprint,conflicts,removalCandidates };
  });
}

export function schedule(jobs, state, config, { manual = false, event = false } = {}) {
  state.queue ??= {}; state.tick ??= 0;
  if (event) state.tick++;
  for (const job of jobs) {
    if (job.routing === 'skip') { delete state.queue[job.domain]; continue; }
    const old = state.queue[job.domain];
    state.queue[job.domain] = { ...old, signature: job.signature, firstTick: old?.firstTick ?? state.tick };
    if (old?.signature !== job.signature) state.queue[job.domain].retryAt = 0;
  }
  const pending = jobs.filter(j => j.routing === 'inspect');
  const eligible = pending.filter(j => manual || ((state.queue[j.domain].retryAt ?? 0) <= state.tick && (j.status !== 'candidate' || state.tick - state.queue[j.domain].firstTick >= config.candidateDelayEvents)));
  // Age is primary: continuous high-priority work cannot starve old candidates.
  const rank = { missing: 0, force: 1, affected: 2, candidate: 3 };
  eligible.sort((a,b) => state.queue[a.domain].firstTick - state.queue[b.domain].firstTick || rank[a.status] - rank[b.status] || a.domain.localeCompare(b.domain));
  return manual ? eligible : eligible.slice(0, config.maxAutoJobs);
}
export function publicJob(job) {
  const { surface, sessionBatch, ...publicFields } = job;
  return { ...publicFields, sessionEpisodes: (sessionBatch ?? []).map(e => ({ id: e.id, hash: e.hash })) };
}
