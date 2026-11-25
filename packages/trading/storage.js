/** Private SQLite records with optimistic revisions and append-only operation events. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, TradingError } from './errors.js';

export class TradingStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL);`);
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('schema_version','1')").run();
    requireThat(this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value === '1', 'SCHEMA_VERSION', '数据库版本不受支持；请保留数据并使用匹配版本。', 409);
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT * FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? { ...JSON.parse(row.body), id: row.id, revision: row.revision, updatedAt: row.updated_at } : null;
  }
  require(kind, id) { const row = this.get(kind, id); requireThat(row, 'NOT_FOUND', '记录不存在。', 404); return row; }
  list(kind, { limit = 200, offset = 0 } = {}) {
    requireThat(Number.isInteger(limit) && limit > 0 && limit <= 1000 && Number.isInteger(offset) && offset >= 0, 'INVALID_PAGE', '分页参数无效。');
    return this.db.prepare('SELECT * FROM records WHERE kind=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').all(kind, limit, offset).map(row => ({ ...JSON.parse(row.body), id: row.id, revision: row.revision, updatedAt: row.updated_at }));
  }
  /** Filter before the optional UI limit; risk callers omit limit to see every active obligation. */
  paperOrders({ accountId, activeOnly = false, limit } = {}) {
    requireThat(accountId === undefined || typeof accountId === 'string' && accountId.length > 0 && accountId.length <= 160, 'INVALID_ID', '模拟账户标识无效。');
    requireThat(typeof activeOnly === 'boolean' && (limit === undefined || Number.isInteger(limit) && limit > 0 && limit <= 1000), 'INVALID_PAGE', '模拟订单查询参数无效。');
    const where = ["kind='order'"], bindings = [];
    if (accountId !== undefined) { where.push("json_extract(body,'$.order.accountId')=?"); bindings.push(accountId); }
    if (activeOnly) where.push("json_extract(body,'$.status') IN ('OPEN','PARTIALLY_FILLED')");
    if (limit !== undefined) bindings.push(limit);
    return this.db.prepare(`SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id${limit === undefined ? '' : ' LIMIT ?'}`).all(...bindings)
      .map(row => ({ ...JSON.parse(row.body), id: row.id, revision: row.revision, updatedAt: row.updated_at }));
  }
  /** Poll due work in due-time order so newer or disabled alerts cannot starve older enabled alerts. */
  dueAlerts(now, limit) {
    requireThat(Number.isFinite(now) && Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'INVALID_PAGE', '提醒轮询时间或数量无效。');
    return this.db.prepare("SELECT * FROM records WHERE kind='alert' AND json_extract(body,'$.enabled')=1 AND json_type(body,'$.nextRunAt') IN ('integer','real') AND json_extract(body,'$.nextRunAt')<=? ORDER BY json_extract(body,'$.nextRunAt') ASC,id LIMIT ?").all(now, limit)
      .map(row => ({ ...JSON.parse(row.body), id: row.id, revision: row.revision, updatedAt: row.updated_at }));
  }
  /** Search all matching chats before pagination; abandoned/deleted chats remain recoverable. */
  searchChats({ query = '', includeArchived = false, includeDeleted = false, limit = 200, offset = 0 } = {}) {
    requireThat(typeof query === 'string' && query.length <= 300 && Number.isInteger(limit) && limit > 0 && limit <= 1000 && Number.isInteger(offset) && offset >= 0, 'INVALID_PAGE', '会话搜索参数无效。');
    const where = ["kind='chat'"], bindings = [];
    if (!includeArchived) where.push("COALESCE(json_extract(body,'$.archived'),0)=0");
    if (!includeDeleted) where.push("COALESCE(json_extract(body,'$.deleted'),0)=0");
    if (query) { where.push("(instr(lower(json_extract(body,'$.title')),lower(?))>0 OR EXISTS(SELECT 1 FROM json_each(records.body,'$.messages') AS msg WHERE instr(lower(json_extract(msg.value,'$.content')),lower(?))>0))"); bindings.push(query, query); }
    const clause = where.join(' AND ');
    const total = this.db.prepare(`SELECT count(*) AS n FROM records WHERE ${clause}`).get(...bindings).n;
    const items = this.db.prepare(`SELECT * FROM records WHERE ${clause} ORDER BY COALESCE(json_extract(body,'$.pinned'),0) DESC,updated_at DESC,id LIMIT ? OFFSET ?`).all(...bindings,limit,offset).map(row=>({...JSON.parse(row.body),id:row.id,revision:row.revision,updatedAt:row.updated_at}));
    return {items,total:Number(total),limit,offset,hasMore:offset+items.length<Number(total)};
  }
  dueRecords(kind, now, limit) {
    requireThat(['brief','alert'].includes(kind) && Number.isFinite(now) && Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'INVALID_PAGE', '任务轮询参数无效。');
    return this.db.prepare("SELECT * FROM records WHERE kind=? AND json_extract(body,'$.enabled')=1 AND json_extract(body,'$.nextRunAt')<=? ORDER BY json_extract(body,'$.nextRunAt'),id LIMIT ?").all(kind,now,limit).map(row=>({...JSON.parse(row.body),id:row.id,revision:row.revision,updatedAt:row.updated_at}));
  }
  /** expectedRevision=0 creates exclusively; every update must name the revision read by the caller. */
  put(kind, id, body, expectedRevision) {
    requireThat(typeof kind === 'string' && typeof id === 'string' && id.length > 0 && id.length <= 160, 'INVALID_ID', '记录标识无效。');
    requireThat(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'REVISION_REQUIRED', '请提供已读取的记录版本。');
    const { id: _id, revision: _revision, updatedAt: _updatedAt, ...value } = body;
    const at = new Date().toISOString();
    if (expectedRevision === 0) {
      const r = this.db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,1,?,?)').run(kind, id, JSON.stringify(value), at);
      requireThat(Number(r.changes) === 1, 'VERSION_CONFLICT', '记录已存在，请刷新后重试。', 409);
    } else {
      const r = this.db.prepare('UPDATE records SET revision=revision+1,body=?,updated_at=? WHERE kind=? AND id=? AND revision=?').run(JSON.stringify(value), at, kind, id, expectedRevision);
      requireThat(Number(r.changes) === 1, 'VERSION_CONFLICT', '记录已更新，请刷新后核对。', 409);
    }
    return this.require(kind, id);
  }
  append(event) { this.db.prepare('INSERT INTO events(id,at,body) VALUES(?,?,?)').run(randomUUID(), new Date().toISOString(), JSON.stringify(event)); }
  events(limit = 100) { requireThat(Number.isInteger(limit) && limit > 0 && limit <= 1000, 'INVALID_PAGE', '审计数量无效。'); return this.db.prepare('SELECT seq,at,body FROM events ORDER BY seq DESC LIMIT ?').all(limit).map(row => ({ seq: row.seq, at: row.at, ...JSON.parse(row.body) })); }
  /** Only synchronous local state changes belong inside this transaction; network requests happen outside. */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); if (result?.then) throw new TradingError('ASYNC_TRANSACTION', '事务内不能等待网络操作。', 500); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
