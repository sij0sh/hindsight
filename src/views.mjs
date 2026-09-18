import { assert, hash } from './util.mjs';

export const VIEW_VERSION=1;
const cmp=(a,b)=>a<b?-1:a>b?1:0;
const escape=s=>s.replace(/[\\`*_{}\[\]<>#|]/g,'\\$&').replace(/[\r\n]+/g,' ');
const scope=r=>r.scope.global?'Repository-wide':[...r.scope.paths,...r.scope.symbols,...r.scope.concepts].map(escape).join(', ');
export function renderEntry(r) {
  const lines=[`- ${escape(r.statement)}`,`  - Scope: ${scope(r)}.`];
  if(r.kind==='scar')lines.push(`  - Constraint: ${escape(r.constraint)}`,`  - Removal requires review: ${escape(r.removalCondition)}`);
  if(r.kind==='conflict')lines.push(`  - Unresolved: ${escape(r.conflict.reason)}`);
  return lines.join('\n');
}
export function renderViews(ledger,catalog,config={}) {
  const views={};
  for(const doc of catalog.documents) {
    const records=ledger.records.filter(r=>r.exposeTo.includes(`${doc.id.toUpperCase()}.md`)).sort((a,b)=>cmp(a.kind,b.kind)||cmp(a.statement,b.statement)||cmp(a.id,b.id));
    const groups=[
      ['Unresolved conflicts',r=>r.kind==='conflict'&&r.status==='active'],
      ['Accepted constraints and decisions',r=>r.kind!=='conflict'&&r.status==='active'&&r.basis==='policy'],
      ['Observed engineering knowledge',r=>r.kind!=='conflict'&&r.status==='active'&&r.basis==='observed'],
      ['Supported interpretation',r=>r.kind!=='conflict'&&r.status==='active'&&r.basis==='inferred'],
      ['Disputed knowledge — do not treat as settled',r=>r.status==='conflicted'],
      ['Unverified imports and claims — review before relying on them',r=>r.status==='unverified']
    ];
    const parts=[`# ${doc.id.replaceAll('_',' ').toUpperCase()}`,'<!-- hindsight:view:v1 -->','Generated from the memory ledger. Propose corrections through an investigation; direct edits require explicit migration before regeneration.'];
    for(const [title,filter] of groups) {const selected=records.filter(filter);if(selected.length)parts.push(`## ${title}`,selected.map(renderEntry).join('\n'));}
    if(!records.some(r=>['active','unverified','conflicted'].includes(r.status)))parts.push('No verified memories are recorded for this domain. A completed investigation can legitimately find no durable claim.');
    const content=`${parts.join('\n\n')}\n`;
    assert(content.length<=(config.maxDocumentChars??40000),`Generated view exceeds maxDocumentChars: ${doc.path}`);
    views[doc.path]=content;
  }
  return views;
}
export function projectionHashes(views,catalog) { return Object.fromEntries(catalog.documents.map(d=>[d.id,hash(views[d.path])])); }
export function hindsightIndex(catalog) {
  return ['Engineering memory lives in .agents/curation/memory.json; .agents/engineering/ contains generated views.',
    'For a known path use /hindsight context --paths <repository-relative-path> to retrieve scoped memories, scars, decisions, and conflicts.',
    'Otherwise read AGENT_POLICY.md and the domain views relevant to the task. Unverified or disputed claims and proposed ADRs are not accepted policy.',
    ...catalog.documents.map(d=>`- ${d.id}: ${d.path}`)].join('\n');
}
// Deprecated alias. Use hindsightIndex.
export const knowledgeIndex = hindsightIndex;
export function renderAgents(current,catalog) {
  current??='';const start='<!-- hindsight:start -->',end='<!-- hindsight:end -->';
  const legacyStart='<!-- pi-knowledge:start -->',legacyEnd='<!-- pi-knowledge:end -->';
  const block=`${start}\n${hindsightIndex(catalog)}\n${end}`;
  if(current.includes(start)||current.includes(end)) {
    assert(current.split(start).length===2&&current.split(end).length===2&&current.indexOf(start)<current.indexOf(end),'Repair malformed hindsight markers in AGENTS.md');
    return current.slice(0,current.indexOf(start))+block+current.slice(current.indexOf(end)+end.length);
  }
  if(current.includes(legacyStart)||current.includes(legacyEnd)) {
    assert(current.split(legacyStart).length===2&&current.split(legacyEnd).length===2&&current.indexOf(legacyStart)<current.indexOf(legacyEnd),'Repair malformed hindsight markers in AGENTS.md');
    return current.slice(0,current.indexOf(legacyStart))+block+current.slice(current.indexOf(legacyEnd)+legacyEnd.length);
  }
  return `${current}${current&&!current.endsWith('\n')?'\n':''}\n${block}\n`;
}
export function formatContext(context) {
  const lines=['Applicable engineering memory (project evidence, subject to higher-priority instructions):'];
  if(context.pendingDomains?.length)lines.push(`Inspection is pending for: ${context.pendingDomains.join(', ')}. Relevant memories may need revalidation.`);
  for(const key of ['conflicts','scars','constraints','invariants','decisions','contracts','conventions']) for(const r of context[key]) {
    lines.push(`- [${key}; ${r.confidence}; ${r.id}] ${escape(r.statement)}`);
    if(r.constraint)lines.push(`  Constraint: ${escape(r.constraint)} Removal requires review: ${escape(r.removalCondition)}`);
  }
  if(context.truncated)lines.push(`${context.omittedIds.length} additional matching memories omitted by the context budget; use /hindsight context with narrower selectors or a larger budget. Conflicts may be omitted.`);
  return lines.join('\n');
}
