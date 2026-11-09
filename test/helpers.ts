import { openDatabase, runMigrations, setDbForTests, type Db } from "@/db/client";
import type { WorkerContext } from "@/core/runner";
import { getConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { applyTestEnv } from "./setup";

export function createTestDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  setDbForTests(db);
  return db;
}

export function testContext(db: Db, envOverrides: Record<string, string | undefined> = {}): WorkerContext {
  applyTestEnv(envOverrides);
  return { db, env: getEnv(), config: getConfig() };
}
