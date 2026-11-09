import { existsSync } from "node:fs";
import type { Env } from "@/lib/env";

export class WebBrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebBrowserUnavailableError";
  }
}

function candidates(): string[] {
  const local = process.env.LOCALAPPDATA;
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ...(local ? [`${local}\\Google\\Chrome\\Application\\chrome.exe`] : []),
    "C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe",
    // Edge ships with every Windows.
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

/** Chrome used, invisible, to draw the slides. */
export function findWebBrowser(env: Pick<Env, "WEB_BROWSER_PATH">): string | null {
  if (env.WEB_BROWSER_PATH) {
    if (!existsSync(env.WEB_BROWSER_PATH)) throw new WebBrowserUnavailableError(`WEB_BROWSER_PATH does not exist: ${env.WEB_BROWSER_PATH}`);
    return env.WEB_BROWSER_PATH;
  }
  return candidates().find((candidate) => existsSync(candidate)) ?? null;
}
