import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length !== 5) throw new Error('Expected input, output, gain, offset, revision');
const [input, output, ...params] = args;
function integer(value) {
  if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid integer: ${value}`);
  return Number(value);
}
const [gain, offset, revision] = params.map(integer);
const text = readFileSync(input, 'utf8').replace(/^\uFEFF/, '');
const rows = [];
let row = [], field = '', quoted = false, closed = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (quoted) {
    if (c === '"') {
      if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else field += c;
  } else if (c === '"' && field === '' && !closed) quoted = true;
  else if (c === ',' || c === '\n' || c === '\r') {
    row.push(field); field = ''; closed = false;
    if (c !== ',') {
      rows.push(row); row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
    }
  } else {
    if (closed || c === '"') throw new Error('Invalid CSV quoting');
    field += c;
  }
}
if (quoted) throw new Error('Unclosed CSV quote');
if (row.length || field !== '' || closed) { row.push(field); rows.push(row); }
const header = rows.shift();
if (!header || new Set(header).size !== header.length || !['id', 'channel', 'raw', 'note'].every(c => header.includes(c))) throw new Error('Invalid CSV header');
const rawIndex = header.indexOf('raw');
let count = 0, rawTotal = 0, convertedTotal = 0;
for (const record of rows) {
  if (record.length !== header.length) throw new Error('Invalid CSV row');
  const raw = integer(record[rawIndex]);
  count++;
  rawTotal += raw;
  convertedTotal += raw * gain + offset;
  if (![count, rawTotal, convertedTotal, raw * gain + offset].every(Number.isSafeInteger)) throw new Error('Integer overflow');
}
writeFileSync(output, JSON.stringify({ count, rawTotal, convertedTotal, gain, offset, revision }, null, 2) + '\n');
