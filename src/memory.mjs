import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { assert, hash, matches, stable, readJson, safePath, validRelative } from './util.mjs';

export const MEMORY_PATH = '.agents/curation/memory.json';
export const DOMAINS = ['intent_and_contracts','architecture','code_standards','testing','security','dependencies','delivery','operations','maintainability','agent_policy'];
export const KINDS = ['invariant','contract','convention','scar','constraint','decision','conflict'];
export const STATUSES = ['active','superseded','resolved','obsolete','unverified','conflicted'];
export const CONFIDENCE = ['authoritative','strong','supported','inferred','conflicted'];
export const OP_NAMES = ['create','reinforce','supersede','invalidate','conflict','resolve','scarCandidates'];
export const emptyLedger = () => ({ version:1, revision:0, records:[], events:[], imports:[], projections:{} });
const id = () => `mem_${randomUUID().replaceAll('-','')}`;
const text = (s,name,max=2000) => assert(typeof s==='string' && s.trim().length>0 && s.length<=max,`Invalid ${name}`);
const strings = (a,name) => assert(Array.isArray(a) && a.every(s=>typeof s==='string' && s.length>0) && new Set(a).size===a.length,`Invalid ${name}`);
const cmp = (a,b) => a<b?-1:a>b?1:0;
export const normalizeStatement = s => s.normalize('NFKC').trim().replace(/\s+/g,' '); // Preserve case/negation/punctuation.
export function validateScope(scope) {
  assert(scope && typeof scope==='object' && typeof scope.global==='boolean','Scope needs an explicit global boolean');
  for(const key of ['paths','symbols','concepts']) strings(scope[key],`scope.${key}`);
  for(const p of scope.paths) validRelative(p);
  assert(scope.global ? !scope.paths.length&&!scope.symbols.length&&!scope.concepts.length : scope.paths.length+scope.symbols.length+scope.concepts.length>0,'Choose global scope or explicit selectors');
}
export function validateRecord(r,config={}) {
  assert(/^mem_[a-f0-9]{32}$/.test(r.id),'Invalid memory ID');
  assert(KINDS.includes(r.kind)&&STATUSES.includes(r.status)&&CONFIDENCE.includes(r.confidence),'Invalid memory enums');
  strings(r.domains,'domains');assert(r.domains.length && r.domains.every(d=>DOMAINS.includes(d)),'Unknown memory domain');
  text(r.statement,'statement',config.maxMemoryStatementChars??1200);
  // Structural limits only. Semantic atomicity belongs to the investigation checklist.
  assert(!/[\r\n]/.test(r.statement),'A memory statement must be one paragraph; split compound claims during investigation');
  validateScope(r.scope);
  strings(r.exposeTo,'exposeTo');
  assert(r.exposeTo.length && r.exposeTo.every(p=>r.domains.some(d=>p===`${d.toUpperCase()}.md`)),'Projection must belong to a record domain');
  assert(Number.isSafeInteger(r.revision)&&r.revision>0,'Invalid record revision');
  assert(['observed','policy','inferred'].includes(r.basis),'Invalid evidence basis');
  for(const key of ['createdAt','lastValidatedAt']) assert(r[key]===null&&key==='lastValidatedAt'||typeof r[key]==='string'&&Number.isFinite(Date.parse(r[key])),`Invalid ${key}`);
  assert(Array.isArray(r.provenance)&&r.provenance.length>0,'Memory needs provenance');
  for(const p of r.provenance) {
    assert(['source','session','doc','decision','inventory'].includes(p.type),'Invalid provenance type');
    for(const key of ['ref','hash','classification','reportPath','at']) text(p[key],`provenance.${key}`);
    assert(Number.isSafeInteger(p.start)&&Number.isSafeInteger(p.end)&&p.start>=0&&p.end>=p.start,'Invalid provenance range');
  }
  for(const key of ['supersedes','contradicts']) strings(r[key],key);
  if(r.kind==='scar') {
    for(const key of ['reason','constraint','removalCondition']) text(r[key],`scar.${key}`);
    assert(['active','candidate_for_removal','resolved'].includes(r.scarState),'Invalid scar lifecycle');
    assert(Array.isArray(r.removalSignals),'Scar requires removalSignals (possibly empty)');
    for(const s of r.removalSignals) { assert(['paths_absent','path_present'].includes(s.type),'Unknown scar signal');validRelative(s.path); }
  }
  if(r.kind==='conflict') {
    assert(r.status==='active'||r.status==='resolved','Conflict uses active/resolved lifecycle');
    assert(r.conflict&&Array.isArray(r.conflict.targets),'Conflict needs targets');
    text(r.conflict.reason,'conflict reason');
  }
}
export function validateLedger(ledger,config={}) {
  assert(ledger?.version===1 && Number.isSafeInteger(ledger.revision)&&ledger.revision>=0,'Unsupported memory ledger');
  assert(Array.isArray(ledger.records)&&ledger.records.length<=(config.maxRecords??2000),'Memory record limit exceeded');
  assert(Array.isArray(ledger.events)&&Array.isArray(ledger.imports)&&ledger.projections&&typeof ledger.projections==='object','Malformed ledger collections');
  const ids=new Set();
  for(const r of ledger.records) { validateRecord(r,config);assert(!ids.has(r.id),'Duplicate memory ID');ids.add(r.id); }
  for(const r of ledger.records) {
    for(const target of [...r.supersedes,...r.contradicts,...(r.conflict?.targets??[])]) assert(ids.has(target)&&target!==r.id,'Memory links must reference another known record');
  }
  const byId=new Map(ledger.records.map(r=>[r.id,r]));
  for(const event of ledger.events) {
    assert(ids.has(event.recordId)&&event.after?.id===event.recordId,'Invalid audit event target');
    validateRecord(event.after,config);
    for(const key of ['id','operation','reason','reportPath','at'])text(event[key],`event.${key}`);
    assert(event.beforeHash===null||/^sha256:[a-f0-9]{64}$/.test(event.beforeHash),'Invalid event beforeHash');
  }
  for(const item of ledger.imports) {validRelative(item.path);assert(/^\.agents\/curation\/migration\/[a-f0-9]{64}\.md$/.test(item.backupPath),'Invalid migration backup');}
  assert(Object.entries(ledger.projections).every(([domain,digest])=>DOMAINS.includes(domain)&&/^sha256:[a-f0-9]{64}$/.test(digest)),'Invalid projection hashes');
  const visiting=new Set(),done=new Set();
  function walk(r) { assert(!visiting.has(r.id),'Supersession cycle');if(done.has(r.id))return;visiting.add(r.id);r.supersedes.forEach(s=>walk(byId.get(s)));visiting.delete(r.id);done.add(r.id); }
  ledger.records.forEach(walk);
  assert(Buffer.byteLength(JSON.stringify(ledger,null,2)+'\n')<=(config.maxLedgerBytes??8000000),'Memory ledger byte limit exceeded; retain an audit backup before deliberate archival');
  return ledger;
}
export async function loadLedger(root,config={}) {
  const path=await safePath(root,MEMORY_PATH);
  try { assert((await lstat(path)).size<=(config.maxLedgerBytes??8000000),'Memory ledger byte limit exceeded'); }
  catch(e) { if(e.code!=='ENOENT')throw e; }
  const ledger=await readJson(root,MEMORY_PATH);
  return ledger===null?null:validateLedger(ledger,config);
}
export function memoryFingerprint(ledger,domain) {
  return hash((ledger?.records??[]).filter(r=>r.domains.includes(domain)).map(r=>{
    const {provenance,createdAt,lastValidatedAt,revision,...semantic}=r;return semantic;
  }).sort((a,b)=>cmp(a.id,b.id)));
}
export const openConflicts = (ledger,domain) => (ledger?.records??[]).filter(r=>r.kind==='conflict'&&r.status==='active'&&(!domain||r.domains.includes(domain)));
export function deriveConfidence(provenance) {
  if(provenance.some(p=>['decision','constraint','reversal'].includes(p.classification)&&(p.type==='session'&&p.role==='user'||p.type==='decision'&&p.accepted===true))) return 'authoritative';
  if(provenance.some(p=>p.type==='source'&&p.classification==='observed')) return 'strong';
  const independent=new Set(provenance.filter(p=>(['source','decision'].includes(p.type)||p.type==='session'&&p.role==='user')&&!['brainstorm','suggestion','request'].includes(p.classification)).map(p=>p.ref.replace(/^(file|index|head):/,'')));
  return independent.size>=2?'supported':'inferred';
}
const projectionNames = domains => [...domains].sort().map(d=>`${d.toUpperCase()}.md`);
function newRecord(input,provenance,now,config) {
  assert(KINDS.includes(input.kind)&&input.kind!=='conflict','Use conflict operations for contradictions');
  text(input.statement,'statement',config.maxMemoryStatementChars??1200);assert(!/[\r\n]/.test(input.statement),'A memory statement must be one paragraph');
  validateScope(input.scope);
  const scope={global:input.scope.global,paths:[...input.scope.paths].sort(),symbols:[...input.scope.symbols].sort(),concepts:[...input.scope.concepts].sort()};
  let confidence=deriveConfidence(provenance);
  const status=confidence==='inferred'||(['decision','constraint'].includes(input.kind)&&confidence!=='authoritative')?'unverified':'active';
  const record={id:id(),revision:1,kind:input.kind,domains:[...new Set(input.domains)].sort(),statement:normalizeStatement(input.statement),scope,status,confidence,basis:confidence==='authoritative'?'policy':confidence==='strong'?'observed':'inferred',provenance,createdAt:now,lastValidatedAt:status==='active'?now:null,supersedes:[],contradicts:[],exposeTo:input.exposeTo??projectionNames(input.domains)};
  if(input.kind==='scar') Object.assign(record,{reason:input.reason,constraint:input.constraint,removalCondition:input.removalCondition,removalSignals:input.removalSignals??[],scarState:'active'});
  validateRecord(record,config);return record;
}
function mergeEvidence(old,added) {
  const key=p=>stable({type:p.type,ref:p.ref,hash:p.hash,start:p.start,end:p.end,classification:p.classification,role:p.role??null});
  const map=new Map(old.map(p=>[key(p),p]));added.forEach(p=>{if(!map.has(key(p)))map.set(key(p),p);});return [...map.values()];
}
const exactKey = r => stable({statement:normalizeStatement(r.statement),scope:r.scope,kind:r.kind,basis:r.basis,reason:r.reason??null,constraint:r.constraint??null,removalCondition:r.removalCondition??null,removalSignals:r.removalSignals??[]});

/** Pure reconciliation: applies to a clone, or throws with the original untouched. */
export function reconcile(ledger,ops,{config={},domain,provenanceFor,reportPath,now=new Date().toISOString(),blocked=false}={}) {
  validateLedger(ledger,config);
  assert(ops&&typeof ops==='object'&&!Array.isArray(ops),'memoryOps must be an operation object');
  assert(Object.keys(ops).every(k=>OP_NAMES.includes(k)),'Unknown memory operation');
  for(const key of OP_NAMES) assert(ops[key]===undefined||Array.isArray(ops[key]),`Invalid ${key} operations`);
  assert(Object.values(ops).flat().length<=100,'Too many memory operations');
  if(blocked) assert(OP_NAMES.filter(k=>k!=='conflict').every(k=>!ops[k]?.length),'Blocked investigations may only record conflicts');
  const next=structuredClone(ledger),affected=new Set(),results=[],localIds=new Map();
  const get=target=>{const r=next.records.find(r=>r.id===target);assert(r,`Unknown memory: ${target}`);assert(!domain||r.domains.includes(domain),`Memory is outside curator domain: ${target}`);return r;};
  const audit=(r,operation,reason,before=null)=>{
    next.events.push({id:`evt_${randomUUID()}`,operation,recordId:r.id,beforeHash:before===null?null:hash(before),after:structuredClone(r),reason,reportPath,at:now});
    r.domains.forEach(d=>affected.add(d));results.push({operation,id:r.id});
  };
  const evidence=op=>{const p=provenanceFor(op);assert(p.length,'Operation requires inspected evidence');return p;};
  const authority=(r,p)=>assert(r.confidence!=='authoritative'||deriveConfidence(p)==='authoritative',`Authoritative memory ${r.id} requires current authoritative evidence to change policy`);
  const modify=(r,op,p,fn)=>{const before=structuredClone(r);fn();r.revision++;r.provenance=mergeEvidence(r.provenance,p);audit(r,op.type,op.reason,before);};
  const create=(input,p,operation='create')=>{
    assert(!domain||input.domains?.includes(domain),'New memory must include the curator domain');
    const r=newRecord(input,p,now,config);
    const existing=next.records.find(x=>['active','unverified'].includes(x.status)&&exactKey(x)===exactKey(r));
    if(existing) {
      const before=structuredClone(existing);existing.domains=[...new Set([...existing.domains,...r.domains])].sort();existing.exposeTo=[...new Set([...existing.exposeTo,...r.exposeTo])].sort();existing.provenance=mergeEvidence(existing.provenance,p);existing.revision++;
      audit(existing,'reinforce_exact_duplicate',input.reason??'Exact same claim and scope',before);return existing;
    }
    next.records.push(r);audit(r,operation,input.reason??'Evidence-backed claim');return r;
  };
  for(const op of ops.create??[]) { const r=create(op,evidence(op));if(op.clientId){assert(!localIds.has(op.clientId),'Duplicate clientId');localIds.set(op.clientId,r.id);} }
  for(const op of ops.scarCandidates??[]) { const r=create({...op,kind:'scar'},evidence(op),'scar_candidate');if(op.clientId)localIds.set(op.clientId,r.id); }
  for(const op of ops.reinforce??[]) {
    const r=get(op.target),p=evidence(op);assert(['active','unverified'].includes(r.status),'Reinforce only active or unverified memories');
    if(r.migration?.scopeNeedsReview){assert(op.atomicityReviewed===true&&op.reviewedScope,'Imported claims require explicit atomicity and scope review before reinforcement');validateScope(op.reviewedScope);}
    if(op.reviewedScope)assert(r.migration?.scopeNeedsReview,'Use supersede to change an established scope');
    modify(r,{...op,type:'reinforce'},p,()=>{if(op.reviewedScope){r.scope={global:op.reviewedScope.global,...Object.fromEntries(['paths','symbols','concepts'].map(k=>[k,[...op.reviewedScope[k]].sort()]))};r.migration.scopeNeedsReview=false;}const strength=deriveConfidence(mergeEvidence(r.provenance,p));if(CONFIDENCE.indexOf(strength)<CONFIDENCE.indexOf(r.confidence))r.confidence=strength;r.basis=r.confidence==='authoritative'?'policy':r.confidence==='strong'?'observed':'inferred';if(r.confidence!=='inferred'&&(!['constraint','decision'].includes(r.kind)||r.confidence==='authoritative')){r.status='active';r.lastValidatedAt=now;}});
  }
  for(const op of ops.supersede??[]) {
    const old=get(op.target),p=evidence(op);assert(['active','unverified','conflicted'].includes(old.status),'Cannot supersede a retired memory');authority(old,p);
    const replacement=newRecord(op.replacement,p,now,config);assert(replacement.status==='active','A replacement must have enough evidence to become active');
    assert(!domain||replacement.domains.includes(domain),'Replacement outside curator domain');
    assert(exactKey(old)!==exactKey(replacement),'Use reinforce for an unchanged claim');
    assert(!next.records.some(r=>r.status==='active'&&exactKey(r)===exactKey(replacement)),'Replacement already exists; resolve explicitly instead of creating a duplicate');
    replacement.supersedes=[old.id];next.records.push(replacement);audit(replacement,'create_replacement',op.reason);
    modify(old,{...op,type:'supersede'},p,()=>{old.status='superseded';});
  }
  for(const op of ops.invalidate??[]) {
    const r=get(op.target),p=evidence(op);assert(r.kind!=='conflict'&&['active','unverified','conflicted'].includes(r.status),'Use resolve for conflicts; retired records are immutable');
    assert(['obsolete','resolved','unverified'].includes(op.status),'Invalid retirement status');authority(r,p);
    modify(r,{...op,type:'invalidate'},p,()=>{r.status=op.status;if(r.kind==='scar'&&op.status==='resolved')r.scarState='resolved';});
  }
  for(const op of ops.conflict??[]) {
    const p=evidence(op),targets=(op.targets??[]).map(get);
    assert(new Set(targets.map(r=>r.id)).size===targets.length&&targets.every(r=>r.kind!=='conflict'&&['active','unverified','conflicted'].includes(r.status)),'Conflict targets must be distinct live claims');
    const domains=[...new Set([...(op.domains??[]),...targets.flatMap(r=>r.domains)])].sort();
    assert(!domain||domains.includes(domain),'Conflict outside curator domain');
    validateScope(op.scope);
    const scopes=[op.scope,...targets.map(r=>r.scope)];
    const scope=scopes.some(s=>s.global)?{global:true,paths:[],symbols:[],concepts:[]}:{global:false,...Object.fromEntries(['paths','symbols','concepts'].map(k=>[k,[...new Set(scopes.flatMap(s=>s[k]))].sort()]))};
    text(op.statement,'conflict statement',config.maxMemoryStatementChars??1200);assert(!/[\r\n]/.test(op.statement),'A conflict statement must be one paragraph');
    const statement=normalizeStatement(op.statement);text(op.reason,'conflict reason');
    let r=next.records.find(r=>r.kind==='conflict'&&r.status==='active'&&r.statement===statement&&stable(r.scope)===stable(scope)&&stable(r.conflict.targets)===stable(targets.map(r=>r.id).sort()));
    if(!r) {
      r={id:id(),revision:1,kind:'conflict',domains,statement,scope,status:'active',confidence:'conflicted',basis:'inferred',createdAt:now,lastValidatedAt:null,provenance:p,supersedes:[],contradicts:targets.map(r=>r.id),exposeTo:projectionNames(domains),conflict:{targets:targets.map(r=>r.id).sort(),reason:op.reason,possibleADR:op.possibleADR??null}};
      next.records.push(r);audit(r,'conflict',op.reason);
    } else {modify(r,{...op,type:'reinforce_conflict'},p,()=>{r.domains=[...new Set([...r.domains,...domains])].sort();r.exposeTo=projectionNames(r.domains);});}
    for(const target of targets) if(['active','unverified'].includes(target.status)) modify(target,{...op,type:'mark_conflicted'},p,()=>{target.preConflictStatus=target.status;target.status='conflicted';target.contradicts=[...new Set([...target.contradicts,r.id])];});
    if(op.clientId){assert(!localIds.has(op.clientId),'Duplicate clientId');localIds.set(op.clientId,r.id);}
  }
  for(const op of ops.resolve??[]) {
    const r=get(op.target),p=evidence(op);assert(r.kind==='conflict'&&r.status==='active','Resolve an active conflict');
    assert(['keep','retired'].includes(op.resolution),'Choose keep or retired');
    if(!r.conflict.targets.length)assert(deriveConfidence(p)==='authoritative','Resolving an open question requires current authoritative evidence');
    for(const targetId of r.conflict.targets) {
      const target=next.records.find(m=>m.id===targetId);
      if(op.resolution==='retired') assert(['superseded','obsolete','resolved'].includes(target.status),'Retire/supersede the contradicted memory before resolving');
      else {
        authority(target,p);
        assert(target.status==='conflicted','Cannot restore a retired memory');
        const other=openConflicts(next).some(c=>c.id!==r.id&&c.conflict.targets.includes(target.id));
        if(!other) modify(target,{...op,type:'restore_after_conflict'},p,()=>{target.status=target.preConflictStatus??'active';delete target.preConflictStatus;});
      }
    }
    // A decision-file name alone is not acceptance; provenanceFor verifies accepted status.
    modify(r,{...op,type:'resolve_conflict'},p,()=>{r.status='resolved';r.lastValidatedAt=now;});
  }
  if(results.length)next.revision++;
  validateLedger(next,config);
  return {ledger:next,affectedDomains:[...affected].sort(),results,localIds:Object.fromEntries(localIds)};
}

export function scarSignals(ledger,files) {
  const present=Object.keys(files).filter(p=>!files[p].missing);
  return (ledger?.records??[]).filter(r=>r.kind==='scar'&&r.status==='active'&&r.removalSignals.length>0).map(r=>({id:r.id,domains:r.domains,signals:r.removalSignals,satisfied:r.removalSignals.every(s=>s.type==='paths_absent'?!present.some(p=>matches([s.path],p)):present.some(p=>matches([s.path],p)))}));
}

export function resolveApplicable(ledger,{paths=[],symbols=[],concepts=[],maxChars=12000}={}) {
  paths.forEach(validRelative);strings(symbols,'query symbols');strings(concepts,'query concepts');
  assert(Number.isSafeInteger(maxChars)&&maxChars>0,'Invalid context budget');
  const matchesScope=r=>r.scope.global||paths.some(p=>matches(r.scope.paths,p))||symbols.some(s=>r.scope.symbols.includes(s))||concepts.some(c=>r.scope.concepts.some(s=>s.toLocaleLowerCase('en')===c.toLocaleLowerCase('en')));
  const rank={conflict:0,scar:1,constraint:2,invariant:3,decision:4,contract:5,convention:6};
  const records=ledger.records.filter(r=>r.status==='active'&&matchesScope(r)).sort((a,b)=>rank[a.kind]-rank[b.kind]||cmp(a.id,b.id));
  const result={invariants:[],contracts:[],conventions:[],scars:[],constraints:[],decisions:[],conflicts:[],truncated:false,omittedIds:[],matched:records.length};let used=0;
  for(const r of records) {
    const item={id:r.id,kind:r.kind,statement:r.statement,scope:r.scope,basis:r.basis,confidence:r.confidence,...(r.kind==='scar'?{constraint:r.constraint,removalCondition:r.removalCondition}:{}),...(r.kind==='conflict'?{targets:r.conflict.targets}: {})};
    const size=JSON.stringify(item).length;
    if(used+size>maxChars){result.truncated=true;result.omittedIds.push(r.id);continue;}
    used+=size;result[`${r.kind}s`].push(item);
  }
  return result;
}
