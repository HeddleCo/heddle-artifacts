// SPDX-License-Identifier: Apache-2.0
export interface OpRow { id: string; command: string; input: string; context: string; status: string; result: string | null; attempts: number; }
export class Store {
  constructor(public storage: DurableObjectStorage) {
    const sql = storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL, keyHash TEXT, enrollment TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS tasks (slug TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS lanes (id TEXT PRIMARY KEY, forkRepo TEXT UNIQUE NOT NULL, data TEXT NOT NULL, tokenId TEXT, subscription TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS pushes (id TEXT PRIMARY KEY, lane TEXT NOT NULL, sha TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', UNIQUE(lane, sha))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ops (id TEXT PRIMARY KEY, command TEXT NOT NULL, input TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL, result TEXT, attempts INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  }
  rows<T extends Record<string, SqlStorageValue>>(sql: string, ...args: SqlStorageValue[]): T[] { return this.storage.sql.exec<T>(sql, ...args).toArray(); }
  get<T = any>(table: string, id: string): T | undefined {
    const key = table === 'tasks' ? 'slug' : table === 'meta' ? 'key' : 'id';
    const row = this.rows<{ data: string }>(`SELECT data FROM ${table} WHERE ${key} = ?`, id)[0];
    return row ? JSON.parse(row.data) as T : undefined;
  }
  all<T = any>(table: string): T[] { return this.rows<{ data: string }>(`SELECT data FROM ${table} ORDER BY rowid`).map(r => JSON.parse(r.data)); }
  put(table: string, id: string, value: unknown) {
    if (table === 'lanes') { this.storage.sql.exec('UPDATE lanes SET data=? WHERE id=?', JSON.stringify(value), id); return; }
    const key = table === 'tasks' ? 'slug' : table === 'meta' ? 'key' : 'id';
    this.storage.sql.exec(`INSERT INTO ${table} (${key}, data) VALUES (?, ?) ON CONFLICT(${key}) DO UPDATE SET data=excluded.data`, id, JSON.stringify(value));
  }
}
