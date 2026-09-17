import { hash, matches, stable } from './util.mjs';

export function route(snapshot, state, catalog, config, { force = false, domain } = {}) {
  return catalog.documents.filter(doc => !domain || doc.id === domain).map(doc => {
    const previous = state.documents?.[doc.id];
    const surface = Object.fromEntries(Object.entries(snapshot.files).filter(([p]) => matches(doc.inputPaths, p)));
    const changed = [...new Set([...Object.keys(surface), ...Object.keys(previous?.files ?? {})])].filter(p => surface[p]?.hash !== previous?.files?.[p]?.hash).sort();
    const sessions = doc.sessions ? snapshot.sessions.filter(s => previous?.sessions?.[s.id] !== s.hash) : [];
    let chars = 0;
    const sessionBatch = [];
    for (const s of sessions) {
      if (sessionBatch.length && chars + s.text.length > config.maxSessionBatchChars) break;
      // An oversized single entry stays pending; it is never silently truncated/acknowledged.
      if (s.text.length > config.maxSessionBatchChars) break;
      sessionBatch.push(s); chars += s.text.length;
    }
    const documentHash = snapshot.documents[doc.id].hash;
    const ruleFingerprint = hash({ doc, common: catalog.common, config });
    const relevantChurn = doc.id === 'maintainability' ? Object.fromEntries(Object.entries(snapshot.churn).filter(([p,n]) => p in surface && n >= config.churnThreshold)) : {};
    const inputFingerprint = hash({ files: Object.fromEntries(Object.entries(surface).map(([p,f]) => [p,f.hash])), sessions: doc.sessions ? snapshot.sessions.map(s => [s.id, s.hash]) : [], churn: relevantChurn });
    const signals = {
      session: sessions.length > 0,
      imports: changed.some(p => stable(surface[p]?.features?.imports ?? []) !== stable(previous?.files?.[p]?.features?.imports ?? [])),
      execution: changed.some(p => stable(surface[p]?.features?.execution ?? []) !== stable(previous?.files?.[p]?.features?.execution ?? [])),
      security: changed.some(p => stable(surface[p]?.features?.security ?? []) !== stable(previous?.files?.[p]?.features?.security ?? [])),
      maintenance: changed.some(p => (surface[p]?.features?.lines ?? 0) > 800 || (surface[p]?.features?.todos ?? 0) > (previous?.files?.[p]?.features?.todos ?? 0)),
      churn: Object.keys(relevantChurn).length > 0 && hash(relevantChurn) !== previous?.churnHash
    };
    const triggers = doc.rules.filter(rule => changed.some(p => matches(rule.paths, p)) || rule.signal && signals[rule.signal]).map(rule => ({ id: rule.id, level: rule.level, files: changed.filter(p => matches(rule.paths, p)), checks: rule.checks, ...(rule.signal ? { signal: rule.signal } : {}) }));
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
    const signature = hash({ inputFingerprint, documentHash, ruleFingerprint, force });
    return { domain: doc.id, document: doc.path, status, routing: status === 'unchanged' ? 'skip' : 'inspect', triggers, changedFiles: changed, checks, inputFingerprint, ruleFingerprint, documentHash, signature, surface, sessionBatch, pendingSessions: sessions.length, sessionBlocked: sessions.length > 0 && sessionBatch.length === 0, churnHash: hash(relevantChurn), baselineCommit: previous?.lastCuratedCommit ?? null, currentCommit: snapshot.head };
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
  return { ...publicFields, sessionEvidence: sessionBatch.map(s => ({ id: s.id, hash: s.hash, role: s.role })) };
}
