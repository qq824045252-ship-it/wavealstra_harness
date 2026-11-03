import { readFileSync, writeFileSync } from 'node:fs';

if (process.argv.length !== 7) throw new Error('Expected input, output, gain, offset, revision');
const [input, output, gainArg, offsetArg, revisionArg] = process.argv.slice(2);
function integer(value) {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid integer: ${value}`);
  return Number(value);
}
const [gain, offset, revision] = [gainArg, offsetArg, revisionArg].map(integer);
const text = readFileSync(input, 'utf8').replace(/^\uFEFF/, '');
const rows = []; let row = [], field = '', quoted = false;
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
if (quoted) throw new Error('Unterminated quoted field');
if (field !== '' || row.length) { row.push(field); rows.push(row); }
const header = rows.shift();
if (!header || !['id', 'channel', 'raw', 'note'].every(name => header.includes(name))) throw new Error('Missing CSV columns');
const rawIndex = header.indexOf('raw');
let count = 0, rawTotal = 0, convertedTotal = 0;
for (const record of rows) {
  if (record.length !== header.length) throw new Error('Invalid CSV row');
  const raw = integer(record[rawIndex]);
  count++; rawTotal += raw; convertedTotal += raw * gain + offset;
  if (![count, rawTotal, convertedTotal, raw * gain + offset].every(Number.isSafeInteger)) throw new Error('Integer exceeds safe range');
}
writeFileSync(output, JSON.stringify({ count, rawTotal, convertedTotal, gain, offset, revision }, null, 2) + '\n');
