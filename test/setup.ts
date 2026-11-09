import path from "node:path";
import { resetConfigCache } from "@/lib/config";
import { resetEnvCache } from "@/lib/env";

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  LOG_SILENT: "true",
  SIMULATION_MODE: "true",
  OPENAI_API_KEY: "sk-test",
  OPENAI_MODEL: "test-model",
  OPENAI_MONTHLY_BUDGET_USD: "50",
  INSTAGRAM_TOKEN: "token-test",
  INSTAGRAM_ACCOUNT_ID: "17840000000000000",
  STATE_ENCRYPTION_KEY: "a".repeat(64),
  PANEL_PASSWORD: "painel-teste-123",
  CONTENT_CONFIG_PATH: path.resolve(__dirname, "fixtures", "conteudo.test.json"),
};

export function applyTestEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const [key, value] of Object.entries({ ...TEST_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
  resetConfigCache();
}

applyTestEnv();
