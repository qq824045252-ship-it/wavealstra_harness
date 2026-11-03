import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length !== 5) throw new Error('Expected input, output, gain, offset, revision');
const [input, output, gainText, offsetText, revisionText] = args;
function integer(text) {
  if (!/^[+-]?\d+$/.test(text)) throw new Error(`Invalid integer: ${text}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error('Integer out of range');
  return value;
}
const gain = integer(gainText), offset = integer(offsetText), revision = integer(revisionText);
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
if (quoted) throw new Error('Unclosed CSV quote');
if (field !== '' || row.length) { row.push(field); rows.push(row); }
const header = rows.shift();
if (!header) throw new Error('Missing header');
const rawIndex = header.indexOf('raw');
if (rawIndex < 0 || !['id', 'channel', 'note'].every(c => header.includes(c))) throw new Error('Missing CSV columns');
let count = 0, rawTotal = 0, convertedTotal = 0;
for (const fields of rows) {
  if (fields.length !== header.length) throw new Error('Invalid CSV row');
  const raw = integer(fields[rawIndex]);
  count++; rawTotal += raw; convertedTotal += raw * gain + offset;
  if (![count, rawTotal, convertedTotal].every(Number.isSafeInteger)) throw new Error('Total out of range');
}
writeFileSync(output, JSON.stringify({ count, rawTotal, convertedTotal, gain, offset, revision }, null, 2) + '\n');
