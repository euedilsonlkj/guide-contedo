// Cria o .env a partir do .env.example e gera a chave e a senha do painel quando estao vazias.
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const created = !existsSync(".env");
if (created) copyFileSync(".env.example", ".env");
let text = readFileSync(".env", "utf8");
let password = null;
if (/^STATE_ENCRYPTION_KEY=[ \t]*$/m.test(text)) text = text.replace(/^STATE_ENCRYPTION_KEY=[ \t]*$/m, `STATE_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`);
if (/^PANEL_PASSWORD=[ \t]*$/m.test(text)) {
  password = randomBytes(9).toString("base64url");
  text = text.replace(/^PANEL_PASSWORD=[ \t]*$/m, `PANEL_PASSWORD=${password}`);
}
writeFileSync(".env", text);
mkdirSync("content/fotos", { recursive: true });
if (password) console.log(`Senha do painel: ${password}  (fica salva no .env, em PANEL_PASSWORD)`);
process.exit(created ? 10 : 0);
