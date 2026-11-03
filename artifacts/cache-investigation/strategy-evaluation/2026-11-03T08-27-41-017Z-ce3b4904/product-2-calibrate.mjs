import { readFileSync, writeFileSync } from 'node:fs';

if (process.argv.length !== 7) throw new Error('Expected input, output, gain, offset, revision');
const [input, output, gainText, offsetText, revisionText] = process.argv.slice(2);
function integer(text) {
  if (!/^[+-]?\d+$/.test(text)) throw new Error(`Invalid integer: ${text}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error('Integer exceeds safe range');
  return value;
}
const gain = integer(gainText), offset = integer(offsetText), revision = integer(revisionText);
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
  } else if (c === ',' || c === '\n' || c === '\r') {
    row.push(field); field = ''; closed = false;
    if (c !== ',') {
      rows.push(row); row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
    }
  } else if (c === '"' && field === '' && !closed) quoted = true;
  else {
    if (closed || c === '"') throw new Error('Invalid CSV quoting');
    field += c;
  }
}
if (quoted) throw new Error('Unterminated CSV field');
if (field !== '' || row.length || closed) { row.push(field); rows.push(row); }
const header = rows.shift();
if (!header || new Set(header).size !== header.length || !['id', 'channel', 'raw', 'note'].every(name => header.includes(name))) throw new Error('Invalid CSV header');
const rawIndex = header.indexOf('raw');
let count = 0, rawTotal = 0, convertedTotal = 0;
for (const values of rows) {
  if (values.length !== header.length) throw new Error('Invalid CSV row');
  const raw = integer(values[rawIndex]);
  count++;
  rawTotal += raw;
  convertedTotal += raw * gain + offset;
  if (![count, rawTotal, convertedTotal, raw * gain, raw * gain + offset].every(Number.isSafeInteger)) throw new Error('Total exceeds safe integer range');
}
writeFileSync(output, JSON.stringify({ count, rawTotal, convertedTotal, gain, offset, revision }, null, 2) + '\n');
