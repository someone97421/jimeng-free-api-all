import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';

// 数据库文件路径
const DB_PATH = process.env.DB_PATH || './data/jimeng.db';

// 确保数据目录存在
fs.ensureDirSync(path.dirname(DB_PATH));

// 初始化数据库连接
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// 初始化表结构
db.exec(`
  -- API Key统计表
  CREATE TABLE IF NOT EXISTS key_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL,
    key_preview TEXT NOT NULL,
    model TEXT NOT NULL,
    credits_used INTEGER DEFAULT 0,
    remaining_credits INTEGER DEFAULT 0,
    call_count INTEGER DEFAULT 1,
    last_used TEXT DEFAULT (datetime('now', 'localtime')),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- 媒体记录表
  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT,
    key_preview TEXT,
    local_path TEXT,
    file_size INTEGER DEFAULT 0,
    content_type TEXT,
    stored_at TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- 日志缓冲表
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- 创建索引
  CREATE INDEX IF NOT EXISTS idx_key_stats_key ON key_stats(key_hash);
  CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
`);

// 为已有数据库补充本地媒体存储字段，保留原有统计和媒体记录
const mediaColumns = db.prepare('PRAGMA table_info(media)').all() as { name: string }[];
const mediaColumnNames = new Set(mediaColumns.map(column => column.name));
if (!mediaColumnNames.has('local_path')) db.exec('ALTER TABLE media ADD COLUMN local_path TEXT');
if (!mediaColumnNames.has('file_size')) db.exec('ALTER TABLE media ADD COLUMN file_size INTEGER DEFAULT 0');
if (!mediaColumnNames.has('content_type')) db.exec('ALTER TABLE media ADD COLUMN content_type TEXT');
if (!mediaColumnNames.has('stored_at')) db.exec('ALTER TABLE media ADD COLUMN stored_at TEXT');

// Key预览（隐藏中间部分）
export function keyPreview(key: string): string {
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

// Key哈希
export function hashKey(key: string): string {
  return crypto.createHash('md5').update(key).digest('hex');
}

// ==================== 统计管理 ====================

export function recordCall(key: string, model: string, creditsUsed: number = 0, remainingCredits: number = 0): void {
  console.log(`[DB] recordCall called: model=${model}, creditsUsed=${creditsUsed}, remainingCredits=${remainingCredits}`);
  const keyHash = hashKey(key);
  const preview = keyPreview(key);
  
  try {
    const existing = db.prepare('SELECT id, call_count, credits_used FROM key_stats WHERE key_hash = ? AND model = ?').get(keyHash, model) as { id: number; call_count: number; credits_used: number } | undefined;
    
    if (existing) {
      db.prepare(`UPDATE key_stats SET call_count = ?, credits_used = ?, remaining_credits = ?, last_used = datetime('now', 'localtime') WHERE id = ?`)
        .run(existing.call_count + 1, existing.credits_used + creditsUsed, remainingCredits, existing.id);
      console.log(`[DB] Updated key_stats: id=${existing.id}, call_count=${existing.call_count + 1}, creditsUsed=${creditsUsed}`);
    } else {
      db.prepare('INSERT INTO key_stats (key_hash, key_preview, model, credits_used, remaining_credits) VALUES (?, ?, ?, ?, ?)')
        .run(keyHash, preview, model, creditsUsed, remainingCredits);
      console.log(`[DB] Inserted new key_stats: model=${model}, preview=${preview}, creditsUsed=${creditsUsed}`);
    }
  } catch (e) {
    console.error(`[DB] recordCall error:`, e);
  }
}

export function getStats() {
  // 按Key汇总（包含剩余积分）
  const keyStats = db.prepare(`
    SELECT key_preview, SUM(call_count) as total_calls, SUM(credits_used) as total_credits, 
           MAX(remaining_credits) as remaining_credits, MAX(last_used) as last_used
    FROM key_stats GROUP BY key_hash ORDER BY total_calls DESC
  `).all();
  
  // 按模型汇总
  const modelStats = db.prepare(`
    SELECT model, SUM(call_count) as total_calls, SUM(credits_used) as total_credits
    FROM key_stats GROUP BY model ORDER BY total_calls DESC
  `).all();
  
  // 总计
  const totals = db.prepare(`
    SELECT SUM(call_count) as total_calls, SUM(credits_used) as total_credits FROM key_stats
  `).get() as { total_calls: number; total_credits: number };
  
  return { keyStats, modelStats, totals };
}

// ==================== 媒体管理 ====================

export function saveMedia(type: 'image' | 'video', url: string, model: string, prompt: string, key: string): number {
  const result = db.prepare('INSERT INTO media (type, url, model, prompt, key_preview) VALUES (?, ?, ?, ?, ?)')
    .run(type, url, model, prompt, keyPreview(key));
  return Number(result.lastInsertRowid);
}

export function updateMediaStorage(id: number, localPath: string, fileSize: number, contentType: string): void {
  db.prepare(`
    UPDATE media
    SET local_path = ?, file_size = ?, content_type = ?, stored_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(localPath, fileSize, contentType, id);
}

export function clearMediaStorage(id: number): void {
  db.prepare(`
    UPDATE media
    SET local_path = NULL, file_size = 0, content_type = NULL, stored_at = NULL
    WHERE id = ?
  `).run(id);
}

export function getMediaStorageRecords() {
  return db.prepare(`
    SELECT id, local_path
    FROM media
    ORDER BY id DESC
  `).all() as { id: number; local_path: string | null }[];
}

export function getMedia(page: number = 1, limit: number = 20, type?: string) {
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const offset = (safePage - 1) * safeLimit;
  let query = 'SELECT * FROM media';
  let countQuery = 'SELECT COUNT(*) as total FROM media';
  const params: any[] = [];
  
  if (type === 'image' || type === 'video') {
    query += ' WHERE type = ?';
    countQuery += ' WHERE type = ?';
    params.push(type);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  
  const items = db.prepare(query).all(...params, safeLimit, offset);
  const countResult = db.prepare(countQuery).get(...params) as { total: number };
  
  return {
    items,
    total: countResult.total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(countResult.total / safeLimit)
  };
}

export function getMediaById(id: number) {
  return db.prepare('SELECT * FROM media WHERE id = ?').get(id);
}

// ==================== 日志管理 ====================

const MAX_LOGS = 1000;

export function addLog(level: string, message: string): void {
  db.prepare('INSERT INTO logs (level, message) VALUES (?, ?)').run(level, message);
  
  // 清理旧日志
  db.prepare(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ${MAX_LOGS})`).run();
}

export function getLogs(level?: string, limit: number = 100) {
  let query = 'SELECT * FROM logs';
  const params: any[] = [];
  
  if (level && level !== 'ALL') {
    query += ' WHERE level = ?';
    params.push(level);
  }
  
  query += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  
  return db.prepare(query).all(...params);
}

export function clearLogs(): void {
  db.prepare('DELETE FROM logs').run();
}

export default {
  recordCall,
  getStats,
  saveMedia,
  updateMediaStorage,
  clearMediaStorage,
  getMediaStorageRecords,
  getMedia,
  getMediaById,
  addLog,
  getLogs,
  clearLogs
};
