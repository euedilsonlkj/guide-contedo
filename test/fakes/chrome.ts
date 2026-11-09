import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Launches a real Chrome with a dedicated profile and the debug port on 127.0.0.1, the
 * same way the operator does (see SETUP.md), so tests exercise connectOverCDP for real.
 */
export interface TestChrome {
  cdpUrl: string;
  process: ChildProcess;
  listTargets: () => Promise<Array<{ id: string; type: string; url: string }>>;
  openUserTab: (url: string) => Promise<string>;
  close: () => Promise<void>;
}

const CANDIDATES = [process.env.CHROME_BIN, "/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean) as string[];

export function findChrome(): string | null {
  return CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** `extraArgs` lets a test tell two Chromes apart (e.g. a distinct --user-agent per account). */
export async function launchTestChrome(extraArgs: string[] = []): Promise<TestChrome> {
  const binary = findChrome();
  if (!binary) throw new Error("Chrome not found; set CHROME_BIN");
  const port = await freePort();
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "agent-profile-"));
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      ...extraArgs,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const cdpUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`);
      if (response.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    cdpUrl,
    process: child,
    listTargets: async () => (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; type: string; url: string }>,
    openUserTab: async (url) => {
      const response = await fetch(`${cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      return ((await response.json()) as { id: string }).id;
    },
    close: async () => {
      child.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 200));
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
}
