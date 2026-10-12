import fs from 'node:fs';
import vm from 'node:vm';
const root='<ENTRY_WORKSPACE>/genuine-v2/evidence/candidates';
const implementations=Object.fromEntries(['native-scan','native-parity'].map(agent=>{
  const ts=fs.readFileSync(`${root}/${agent}/src/table.ts`,'utf8');
  // Erase only the inspected source's three TypeScript annotations and export modifiers.
  const js=ts.replaceAll('export function ','function ').replaceAll(': string[][]','').replaceAll(': string[]','').replaceAll(': string','');
  return [agent,vm.runInNewContext(js+'; ({parseRow,parseTable});',Object.create(null),{timeout:1000})];
}));
function oracle(row){
  const tokens=row.trim().match(/\\[\\|]|[\s\S]/g)??[];
  if(tokens[0]==='|')tokens.shift();
  if(tokens.at(-1)==='|')tokens.pop();
  const cells=[''];
  for(const token of tokens){
    if(token==='|')cells.push('');
    else cells[cells.length-1]+=token.length===2&&token[0]==='\\'?token[1]:token;
  }
  return cells.map(cell=>cell.trim());
}
function check(row){
  const expected=JSON.stringify(oracle(row));
  for(const [agent,fn] of Object.entries(implementations)){
    const actual=JSON.stringify(fn.parseRow(row));
    if(actual!==expected)throw new Error(JSON.stringify({agent,row,expected,actual}));
  }
}
let exhaustive=0;
const alphabet=['a','|','\\',' ','\t','α'];
function walk(row,remaining){check(row);exhaustive++;if(remaining)for(const char of alphabet)walk(row+char,remaining-1);}
walk('',7);
let targeted=0;
for(let count=0;count<=4096;count++){
  for(const suffix of ['|right','|','q','']){
    const row='left'+'\\'.repeat(count)+suffix;
    check(row);check('| '+row+'  ');targeted+=2;
  }
}
function baseline(row){let text=row.trim();if(text.startsWith('|'))text=text.slice(1);if(text.endsWith('|'))text=text.slice(0,-1);return text.split('|').map(cell=>cell.trim());}
let baselineCases=0;
function compareBaseline(row,remaining){
  const expected=JSON.stringify(baseline(row));
  for(const [agent,fn] of Object.entries(implementations))if(JSON.stringify(fn.parseRow(row))!==expected)throw new Error('baseline mismatch '+agent+' '+JSON.stringify(row));
  baselineCases++;if(remaining)for(const char of ['a','|',' ','\t'])compareBaseline(row+char,remaining-1);
}
compareBaseline('',7);
console.log(JSON.stringify({status:'pass',implementations:Object.keys(implementations),exhaustiveRows:exhaustive,alphabet,maxLength:7,backslashRunCounts:'0..4096 inclusive',targetedRows:targeted,nonEscapeBaselineRows:baselineCases,method:'Read-only execution of independently inspected pure parser source, type-erased in memory; regex-token oracle and baseline comparison; no dependencies or source edits'},null,2));
