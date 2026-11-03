import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length !== 5) throw new Error('Expected input, output, gain, offset, revision');
const [input, output, ...parameters] = args;
function integer(value) {
  if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid integer: ${value}`);
  return Number(value);
}
const [gain, offset, revision] = parameters.map(integer);
const text = readFileSync(input, 'utf8').replace(/^\uFEFF/, '');
const rows = []; let row = [], field = '', quoted = false, closed = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (quoted) {
    if (c === '"') {
      if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else field += c;
  } else if (c === ',' || c === '\n' || c === '\r') {
    row.push(field); field = ''; closed = false;
    if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
  } else if (c === '"' && field === '' && !closed) quoted = true;
  else { if (closed || c === '"') throw new Error('Invalid CSV'); field += c; }
}
if (quoted) throw new Error('Unclosed CSV quote');
if (row.length || field || closed) { row.push(field); rows.push(row); }
const header = rows.shift();
if (!header || !['id', 'channel', 'raw', 'note'].every(name => header.includes(name))) throw new Error('Missing CSV columns');
const rawIndex = header.indexOf('raw');
let count = 0, rawTotal = 0, convertedTotal = 0;
for (const fields of rows) {
  if (fields.length !== header.length) throw new Error('Invalid CSV row');
  const raw = integer(fields[rawIndex]);
  count++; rawTotal += raw; convertedTotal += raw * gain + offset;
  if (![count, rawTotal, convertedTotal, raw * gain + offset].every(Number.isSafeInteger)) throw new Error('Integer exceeds safe range');
}
writeFileSync(output, JSON.stringify({ count, rawTotal, convertedTotal, gain, offset, revision }, null, 2) + '\n');
