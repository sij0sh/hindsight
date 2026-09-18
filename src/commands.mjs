import { assert } from './util.mjs';

export function tokenize(text) {
  const tokens=[];let token='',quote=null,started=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quote) {if(c===quote)quote=null;else if(c==='\\'&&text[i+1]===quote)token+=text[++i];else token+=c;started=true;}
    else if(c==='"'||c==="'"){quote=c;started=true;}
    else if(/\s/.test(c)){if(started){tokens.push(token);token='';started=false;}}
    else {token+=c;started=true;}
  }
  assert(!quote,'Unclosed argument quote');if(started)tokens.push(token);return tokens;
}
export function parseCommand(args) {
  args=[...args];const command=args.shift()??'scan';
  const result={command,query:{paths:[],symbols:[],concepts:[]}};
  while(args.length) {
    const token=args.shift();
    if(token==='--cwd'){assert(args.length,'--cwd requires a path');result.cwd=args.shift();}
    else if(token==='--migrate'){assert(command==='init','--migrate only applies to init');result.migrate=true;}
    else if(command==='context'&&['--paths','--symbols','--concepts'].includes(token)) {
      const values=[];while(args.length&&!args[0].startsWith('--'))values.push(args.shift());assert(values.length,`${token} requires values`);result.query[token.slice(2)].push(...values);
    } else if(command==='context'&&token==='--max-chars'){assert(args.length,'--max-chars requires a number');result.query.maxChars=Number(args.shift());}
    else {assert(!token.startsWith('--')&&result.arg===undefined,'Unexpected argument; see README command syntax');result.arg=token;}
  }
  assert(command!=='context'||result.arg===undefined,'context uses --paths, --symbols, or --concepts');
  return result;
}
