import { emptyLedger, validateLedger } from './memory.mjs';
import { hash, assert } from './util.mjs';
import { renderEntry } from './views.mjs';

function proseBlocks(content) {
  const blocks=[];let start=null,end=0,fenced=false;
  const flush=()=>{if(start!==null)blocks.push({text:content.slice(start,end).trim(),start,end});start=null;};
  for(const match of content.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line=match[0],trimmed=line.trim();if(!line)continue;
    if(!fenced&&(!trimmed||/^#+\s/.test(trimmed)||/^<!--.*-->$/.test(trimmed))){flush();continue;}
    if(!fenced&&/^(?:[-*+] |\d+\. )/.test(line))flush();
    if(start===null)start=match.index;end=match.index+line.length;
    if(/^\s*(```|~~~)/.test(line))fenced=!fenced;
  }
  flush();return blocks;
}

// Import candidates, not inferred policies. Full original bytes are separate transaction targets.
export function importDocuments(ledger,documents,config,now=new Date().toISOString()) {
  const next=structuredClone(ledger??emptyLedger()),backups=[],imported=[];
  for(const [domain,doc] of Object.entries(documents)) {
    if(doc.content===null||next.projections[domain]===doc.hash)continue;
    if(next.imports.some(i=>i.path===doc.path&&i.hash===doc.hash)) {
      // A user restored a previous original; regenerating is still an explicit migrate action.
      continue;
    }
    const digest=hash(`${doc.path}\0${doc.content}`).slice(7),backupPath=`.agents/curation/migration/${digest}.md`;
    backups.push({path:backupPath,previousContent:null,nextContent:doc.content});
    const blocks=proseBlocks(doc.content);
    const rendered=new Set(next.records.filter(r=>r.domains.includes(domain)).map(renderEntry));
    for(const block of blocks) {
      const raw=block.text;
      if(!raw||raw.startsWith('Generated from the memory ledger.')||raw.startsWith('No verified memories are recorded')||rendered.has(raw))continue;
      const statement=raw.replace(/^(?:[-*+]\s+|\d+\.\s+)/,'').replace(/\s+/g,' ');
      // Already rendered claims are not imported again after a small manual edit.
      if(next.records.some(r=>statement===r.statement&&r.domains.includes(domain)))continue;
      const candidateId=`mem_${hash(`${doc.path}\0${doc.hash}\0${block.start}`).slice(7,39)}`;
      if(next.records.some(r=>r.id===candidateId))continue;
      const display=statement.length<=config.maxMemoryStatementChars?statement:`${statement.slice(0,Math.max(1,config.maxMemoryStatementChars-100))} [Excerpt; review the archived original before splitting this candidate.]`;
      const record={id:candidateId,revision:1,kind:'convention',domains:[domain],statement:display,scope:{global:true,paths:[],symbols:[],concepts:[]},status:'unverified',confidence:'inferred',basis:'inferred',provenance:[{type:'doc',ref:doc.path,hash:doc.hash,start:block.start,end:block.end,classification:'legacy-import',reportPath:'migration',at:now}],createdAt:now,lastValidatedAt:null,supersedes:[],contradicts:[],exposeTo:[`${domain.toUpperCase()}.md`],migration:{backupPath,sourcePath:doc.path,scopeNeedsReview:true}};
      next.records.push(record);next.events.push({id:`migration_${candidateId}`,operation:'import_unverified',recordId:record.id,beforeHash:null,after:structuredClone(record),reason:'Explicit Markdown migration; scope and claim atomicity require investigation',reportPath:'migration',at:now});imported.push(record.id);
    }
    next.imports.push({path:doc.path,hash:doc.hash,backupPath,at:now});
  }
  if(backups.length)next.revision++;
  validateLedger(next,config);
  assert(backups.length<=10,'Unexpected migration target count');
  return {ledger:next,backups,imported};
}
