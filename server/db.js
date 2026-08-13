import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'surfboard.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** server/migrations/*.sql 을 파일명 순서대로 한 번씩만 적용합니다. */
export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const dir = new URL('./migrations/', import.meta.url);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const done = new Set(db.prepare('SELECT name FROM _migrations').all().map(r => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(new URL(f, dir), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    })();
    console.log(`[db] 마이그레이션 적용: ${f}`);
  }
}
