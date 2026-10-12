// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [schemaFile, transcriptFile, moduleDirectory] = process.argv.slice(2);
assert(schemaFile && transcriptFile && moduleDirectory, 'Provide engine.schema.json, e2e contract.jsonl, and the validator node_modules directory');
const { default: Ajv } = await import(pathToFileURL(resolve(moduleDirectory, 'ajv/dist/2020.js')));
const { default: formats } = await import(pathToFileURL(resolve(moduleDirectory, 'ajv-formats/dist/index.js')));
const schema = JSON.parse(await readFile(schemaFile));
const ajv = new Ajv({ strict: false, allErrors: true }); formats(ajv); ajv.addSchema(schema);
const transcript = (await readFile(transcriptFile, 'utf8')).trim().split('\n').map(JSON.parse);
let count = 0; const commands = new Set();
for (const record of transcript) {
  if (record.exit !== 0) continue;
  for (const direction of ['input', 'output']) {
    if (record[direction] === undefined) continue;
    const validate = ajv.getSchema(schema.$id + '#/$defs/' + record.cmd + '.' + direction);
    assert(validate(record[direction]), `${record.cmd}.${direction}: ${JSON.stringify(validate.errors)}`);
    count++;
  }
  commands.add(record.cmd);
}
assert.equal(commands.size, 14, 'Every JSON command has real contract evidence');
console.log(`Contracts PASS: ${count} real JSON request/response checks against Track A engine.schema.json; ${commands.size} JSON commands; snapshot verified separately as tar.zst`);
const validate = ajv.getSchema(schema.$id + '#/$defs/candidates.output');
const broken = structuredClone(transcript.find(r => r.cmd === 'candidates' && r.exit === 0).output);
delete broken.candidates[0].signedBy;
assert.equal(validate(broken), false);
console.log('Contracts negative PASS: remove candidate signedBy → schema rejects the real response');
