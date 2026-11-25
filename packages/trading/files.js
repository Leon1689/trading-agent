import { createHash, randomUUID } from 'node:crypto';
import { requireThat, TradingError } from './errors.js';

/** Parse quoted CSV including embedded line breaks; never evaluate spreadsheet formulas. */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += ch; continue; }
    if (ch === '"') { requireThat(cell === '' && !closed, 'INVALID_CSV', 'CSV引号位置无效。'); quoted = true; }
    else if (ch === ',') { row.push(cell); cell = ''; closed = false; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; closed = false; }
    else { requireThat(!closed, 'INVALID_CSV', 'CSV引号后只能是分隔符。'); cell += ch; }
  }
  requireThat(!quoted, 'INVALID_CSV', 'CSV引号未闭合。');
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((v, i) => i === 0 ? v.replace(/^\uFEFF/, '') : v);
  requireThat(headers.every(h => h && !['__proto__', 'constructor', 'prototype'].includes(h)) && new Set(headers).size === headers.length, 'INVALID_CSV', 'CSV字段名为空、重复或不受支持。');
  return rows.filter(r => !(r.length === 1 && r[0] === '')).map(r => { requireThat(r.length === headers.length, 'INVALID_CSV', 'CSV行列数不一致。'); return Object.fromEntries(headers.map((h, i) => [h, r[i]])); });
}

/** Exact decimal-money import; duplicate IDs with different fields are conflicts, never guessed duplicates. */
export function inspectEvents(rows) {
  requireThat(Array.isArray(rows), 'INVALID_EVENTS', '事件导入需要数组。');
  const byId = new Map(); const currencies = new Map(); let duplicates = 0;
  const stable = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  for (const row of rows) {
    requireThat(row && typeof row === 'object' && !Array.isArray(row), 'INVALID_EVENTS', '事件必须是对象。');
    const id = row.event_id ?? row.id;
    requireThat(typeof id === 'string' && id.length > 0, 'EVENT_ID_REQUIRED', '每条事件必须有稳定event_id，不能用日期金额猜重复。');
    if (byId.has(id)) { requireThat(stable(byId.get(id)) === stable(row), 'EVENT_CONFLICT', '同一事件ID内容冲突，未导入。', 409, { id }); duplicates++; continue; }
    byId.set(id, row);
    requireThat(typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency), 'CURRENCY_REQUIRED', '事件需要明确币种。');
    const raw = String(row.amount);
    requireThat(/^-?\d{1,12}(\.\d{1,2})?$/.test(raw), 'INVALID_AMOUNT', '事件金额须为整笔金额且最多两位小数。');
    const negative = raw.startsWith('-'); const [whole, part = ''] = raw.replace(/^-/, '').split('.');
    const cents = (BigInt(whole) * 100n + BigInt(part.padEnd(2, '0'))) * (negative ? -1n : 1n);
    currencies.set(row.currency, (currencies.get(row.currency) ?? 0n) + cents);
  }
  const totals = Object.fromEntries([...currencies].map(([currency, cents]) => { const abs = cents < 0n ? -cents : cents; return [currency, `${cents < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`]; }));
  return { rows: [...byId.values()], uniqueEvents: byId.size, duplicates, totals, ledgerUpdated: false };
}

export function importFile(store, input, limits) {
  requireThat(typeof input.name === 'string' && input.name.length > 0 && input.name.length <= 160 && !/[\/\\\x00]/.test(input.name), 'INVALID_NAME', '文件名不能包含路径。');
  const mimeType = input.mimeType || (input.name.endsWith('.csv') ? 'text/csv' : input.name.endsWith('.json') ? 'application/json' : 'text/plain');
  let payload, parsed = null;
  if (input.dataBase64 !== undefined) {
    requireThat(['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) && typeof input.dataBase64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64), 'INVALID_IMAGE', '仅支持PNG/JPEG/WebP图片。');
    const bytes = Buffer.from(input.dataBase64, 'base64');
    requireThat(bytes.length > 0 && bytes.length <= limits.imageBytes, 'FILE_TOO_LARGE', '图片大小超过配置限制。', 413);
    const signature = mimeType === 'image/png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : mimeType === 'image/jpeg' ? bytes.subarray(0, 3).toString('hex') === 'ffd8ff' : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    requireThat(signature, 'INVALID_IMAGE', '图片类型与文件内容不一致。'); payload = { dataBase64: bytes.toString('base64'), bytes: bytes.length };
  } else {
    requireThat(typeof input.content === 'string' && Buffer.byteLength(input.content) <= limits.textFileBytes, 'FILE_TOO_LARGE', '文本文件无效或超过配置限制。', 413);
    requireThat(['text/csv', 'application/json', 'text/plain', 'text/markdown', 'application/x-ndjson'].includes(mimeType), 'UNSUPPORTED_FILE', '当前支持CSV、JSON、JSONL、文本、Markdown和图片。');
    if (mimeType === 'text/csv') parsed = parseCsv(input.content);
    if (mimeType === 'application/json') { try { parsed = JSON.parse(input.content); } catch (error) { throw new TradingError('INVALID_JSON', 'JSON文件解析失败。'); } }
    if (mimeType === 'application/x-ndjson') { try { for (const line of input.content.split(/\r?\n/).filter(v => v.trim())) JSON.parse(line); } catch { throw new TradingError('INVALID_JSON', 'JSONL条目解析失败。'); } }
    payload = { content: input.content, bytes: Buffer.byteLength(input.content) };
  }
  const checksum = createHash('sha256').update(payload.content ?? payload.dataBase64).digest('hex');
  return store.put('file', randomUUID(), { name: input.name, mimeType, ...payload, parsed, checksum, createdAt: new Date().toISOString() }, 0);
}
