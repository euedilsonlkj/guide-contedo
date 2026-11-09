import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export function databaseFilePath(url: string): string {
  const withoutScheme = url.startsWith("file:") ? url.slice("file:".length) : url;
  return withoutScheme === ":memory:" ? withoutScheme : path.resolve(withoutScheme);
}

export function openDatabase(url: string): Db {
  const filePath = databaseFilePath(url);
  if (filePath !== ":memory:") mkdirSync(path.dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  return drizzle(sqlite, { schema }) as Db;
}

export function migrationsFolder(): string {
  return path.join(process.cwd(), "drizzle");
}

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}

const globalForDb = globalThis as unknown as { __appDb?: Db };

/** Process-wide connection. Panel and worker run in one process. */
export function getDb(): Db {
  if (!globalForDb.__appDb) {
    globalForDb.__appDb = openDatabase(process.env.DATABASE_URL ?? "file:./data/conteudo.db");
  }
  return globalForDb.__appDb;
}

export function setDbForTests(db: Db | undefined): void {
  globalForDb.__appDb = db;
}
