import { readdir,readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRegistry } from '../src/config.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const dir of ['src','scripts','test']) for(const file of await readdir(new URL(`../${dir}/`,import.meta.url))) if(file.endsWith('.mjs')) execFileSync(process.execPath,['--check',`${root}${dir}/${file}`],{stdio:'inherit'});
execFileSync(process.execPath,['--check',`${root}extension.ts`],{stdio:'inherit'});
validateRegistry(JSON.parse(await readFile(new URL('../catalog/registry.json',import.meta.url),'utf8')));
console.log('Syntax and registry checks passed.');
