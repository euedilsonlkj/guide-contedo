// Prints how many Gemini accounts the .env asks for (GEMINI_ACCOUNTS), 2 when missing.
// Tolerates spaces, quotes, a BOM and Windows line endings.
import { existsSync, readFileSync } from "node:fs";

let count = 2;
if (existsSync(".env")) {
  const text = readFileSync(".env", "utf8").replace(/^\uFEFF/, "");
  const match = /^[ \t]*GEMINI_ACCOUNTS[ \t]*=[ \t]*["']?(\d+)/m.exec(text);
  if (match) count = Math.min(4, Math.max(1, Number(match[1])));
}
console.log(count);
