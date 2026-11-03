import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length !== 5) throw new Error('Expected input, output, gain, offset, revision');
const [input, output, ...parameters] = args;
function integer(value) {
  if (!/^[+-]?\d+$/.test(value)) throw new Error(`Invalid integer: ${value}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Integer outside safe range');
  return result;
}
const [gain, offset, revision] = parameters.map(integer);
const text = readFileSync(input, 'utf8').replace(/^\uFEFF/, '');
const rows = [];
let row = [], field = '', quoted = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (quoted) {
    if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
    else if (c === '"') quoted = false;
    else field += c;
  } else if (c === '"' && field === '') quoted = true;
  else if (c === ',') { row.push(field); field = ''; }
  else if (c === '\n' || c === '\r') {
    if (c === '\r' && text[i + 1] === '\n') i++;
    row.push(field); rows.push(row); row = []; field = '';
  } else field += c;
}
if (quoted) throw new Error('Unclosed CSV quote');
if (field !== '' || row.length) { row.push(field); rows.push(row); }
const header = rows.shift();
if (!header || !['id', 'channel', 'raw', 'note'].every(name => header.includes(name))) throw new Error('Missing CSV columns');
const rawIndex = header.indexOf('raw');
let count = 0, rawTotal = 0, convertedTotal = 0;
for (const values of rows) {
  if (values.length !== header.length) throw new Error('Invalid CSV row');
  const raw = integer(values[rawIndex]);
  count++;
  rawTotal += raw;
  convertedTotal += raw * gain + offset;
  if (![count, rawTotal, convertedTotal].every(Number.isSafeInteger)) throw new Error('Total outside safe integer range');
}
writeFileSync(output, JSON.stringify({ count, rawTotal, convertedTotal, gain, offset, revision }, null, 2) + '\n');
