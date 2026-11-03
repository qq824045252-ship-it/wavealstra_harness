import { readFileSync, writeFileSync } from 'node:fs';

if (process.argv.length !== 7) throw new Error('Expected input, output, gain, offset, revision');
const [input, output, gainText, offsetText, revisionText] = process.argv.slice(2);
function integer(value) {
  if (!/^[+-]?\d+$/.test(value)) throw new Error(`Invalid integer: ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Integer out of range');
  return number;
}
const [gain, offset, revision] = [gainText, offsetText, revisionText].map(integer);
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
if (quoted) throw new Error('Unterminated CSV quote');
if (row.length || field) { row.push(field); rows.push(row); }
const header = rows.shift();
if (!header || !['id', 'channel', 'raw', 'note'].every(name => header.includes(name))) throw new Error('Missing CSV columns');
const rawIndex = header.indexOf('raw');
let count = 0, rawTotal = 0, convertedTotal = 0;
for (const fields of rows) {
  if (fields.length !== header.length) throw new Error('Invalid CSV row');
  const raw = integer(fields[rawIndex]);
  count++;
  rawTotal += raw;
  convertedTotal += raw * gain + offset;
  if (![count, rawTotal, convertedTotal, raw * gain + offset].every(Number.isSafeInteger)) throw new Error('Integer out of range');
}
writeFileSync(output, JSON.stringify({ count, rawTotal, convertedTotal, gain, offset, revision }, null, 2) + '\n');
