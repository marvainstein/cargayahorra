import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;
// node:sqlite devuelve objetos sin prototipo; los tratamos como registros genéricos.
export type Row = Record<string, any>;

const SCHEMA_VERSION = 1;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  db.exec(schema);
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as Row | undefined;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  // Columnas agregadas después de la versión inicial (CREATE TABLE IF NOT EXISTS no las agrega).
  const cols = (db.prepare('PRAGMA table_info(promotion)').all() as Row[]).map((c) => c.name);
  if (!cols.includes('source_fingerprint')) db.exec('ALTER TABLE promotion ADD COLUMN source_fingerprint TEXT');
  const addColumn = (table: string, column: string, ddl: string) => {
    const existing = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name);
    if (!existing.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumn('customer_segment', 'group_id', 'group_id TEXT');
  addColumn('station', 'attributes_json', "attributes_json TEXT NOT NULL DEFAULT '{}'");
  addColumn('station', 'source', 'source TEXT');
  addColumn('fuel_transaction_promotion', 'expected_amount', 'expected_amount INTEGER');
}

/** Ejecuta fn dentro de una transacción. */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function all(db: DB, sql: string, ...params: any[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

export function get(db: DB, sql: string, ...params: any[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

export function run(db: DB, sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}
