import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
        created_at INTEGER NOT NULL, sent_at INTEGER);
    `);
  }
  get(key) { return this.db.prepare('SELECT value FROM state WHERE key=?').get(key)?.value; }
  set(key, value) {
    this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }
  enqueue(text) { this.db.prepare('INSERT INTO outbox(text,created_at) VALUES (?,?)').run(text, Date.now()); }
  observe(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid unread count');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get('unread');
      if (previous !== undefined && count > Number(previous)) {
        this.enqueue(`🔔 На Авито выросло число непрочитанных чатов: ${previous} → ${count}.\nОткройте Авито, чтобы ответить.\nhttps://www.avito.ru/profile/messenger`);
      }
      this.set('unread', count);
      this.set('last_success', Date.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pending() { return this.db.prepare('SELECT id,text FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT 20').all(); }
  sent(id) { this.db.prepare('UPDATE outbox SET sent_at=? WHERE id=?').run(Date.now(), id); }
  close() { this.db.close(); }
}
