import { existsSync } from "node:fs";
import { getDb, runMigrations } from "@/db/client";
import { recoverRunningJobs } from "@/core/queue";
import { Worker } from "@/core/runner";
import { startPanel } from "@/panel/server";
import { getConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = getEnv();
const config = getConfig();
const db = getDb();
runMigrations(db);
const recovered = recoverRunningJobs(db);

const worker = new Worker({ db, env, config });
worker.start();
const server = await startPanel({ db, env, config });
logger.info("conteudo started", { panel: `http://127.0.0.1:${env.PORT}`, account: config.brand.handle, recovered });
process.stdout.write(`\nPainel do conteudo: http://127.0.0.1:${env.PORT}  (usuario qualquer, senha PANEL_PASSWORD do .env)\n\n`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("stopping", { signal });
  server.close();
  await worker.stop();
  db.$client.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGHUP", () => void shutdown("SIGHUP"));
if (process.platform === "win32") process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
