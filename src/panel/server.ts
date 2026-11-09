import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { alerts, contentPosts, type ContentPost } from "@/db/schema";
import { acknowledgeAlert } from "@/core/journal";
import { absoluteFromRoot, contentTypeOf, mediaExists, mediaPath, ownerPhotos, publicBaseUrl, verifyMediaToken } from "@/content/files";
import { contentPaused, geminiAccounts, geminiBlockedUntil, geminiDownUntil, geminiUsedToday, markPublished, pillarOf, postsBetween, publishNow, retryPost, rewritePost, setContentPaused, skipPost } from "@/content/posts";
import { escapeHtml as esc } from "@/content/render";
import { probeBrowser } from "@/integrations/gemini/web";
import { hasMetaCredentials } from "@/integrations/instagram/publish";
import { monthToDateSpend } from "@/integrations/openai/client";
import type { ContentConfig } from "@/lib/config";
import type { Env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { DAY_MS, localClock } from "@/lib/time";

/**
 * The operator's panel (http://127.0.0.1:3200, password PANEL_PASSWORD) and the public route
 * Meta downloads the files from. Only /api/content/media (each URL signed with an HMAC) and
 * /api/health answer without the password, so the tunnel exposes nothing else.
 */

export interface PanelContext {
  db: Db;
  env: Env;
  config: ContentConfig;
}

const STATUS: Record<ContentPost["status"], { label: string; tone: string }> = {
  planned: { label: "Pauta definida", tone: "neutral" },
  written: { label: "Texto pronto, gerando mídia", tone: "accent" },
  media_ready: { label: "Desenhando", tone: "accent" },
  ready: { label: "Pronto, aguardando horário", tone: "ok" },
  publishing: { label: "Publicando", tone: "accent" },
  published: { label: "Publicado", tone: "ok" },
  failed: { label: "Parado, precisa de você", tone: "bad" },
  skipped: { label: "Pulado", tone: "neutral" },
};

function authorized(req: IncomingMessage, password: string): boolean {
  const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const supplied = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
  const expected = Buffer.from(password);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function serveMedia(ctx: PanelContext, pathname: string, head: boolean, res: ServerResponse): void {
  const match = /^\/api\/content\/media\/([0-9a-f]+)\/(.+)$/.exec(pathname);
  if (!match) return void res.writeHead(404).end();
  let relative: string;
  try {
    relative = match[2].split("/").map(decodeURIComponent).join("/");
  } catch {
    return void res.writeHead(404).end();
  }
  const file = verifyMediaToken(ctx.env, relative, match[1]) ? absoluteFromRoot(ctx.env, relative) : null;
  let size = 0;
  try {
    size = file ? statSync(file).size : 0;
  } catch {
    size = 0;
  }
  if (!file || size === 0) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": contentTypeOf(file), "content-length": String(size), "cache-control": "private, max-age=3600" });
  res.end(head ? undefined : readFileSync(file));
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) break;
  }
  return new URLSearchParams(raw);
}

function act(ctx: PanelContext, form: URLSearchParams): void {
  const action = form.get("action");
  const id = Number(form.get("postId"));
  if (action === "pause") return setContentPaused(ctx.db, true);
  if (action === "resume") return setContentPaused(ctx.db, false);
  if (action === "ack" && Number.isInteger(Number(form.get("alertId")))) return acknowledgeAlert(ctx.db, Number(form.get("alertId")));
  if (!Number.isInteger(id) || id <= 0) return;
  if (action === "retry") retryPost(ctx.db, id);
  else if (action === "rewrite") rewritePost(ctx.db, id);
  else if (action === "skip") skipPost(ctx.db, id);
  else if (action === "publish") publishNow(ctx.db, id);
  else if (action === "published") markPublished(ctx.db, id);
}

const WEEKDAY = (tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit" });
const TIME = (tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" });

function button(postId: number, action: string, label: string, confirm?: string): string {
  return `<form method="post" action="/acao"${confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : ""}><input type="hidden" name="postId" value="${postId}"><input type="hidden" name="action" value="${action}"><button class="small">${esc(label)}</button></form>`;
}

function preview(ctx: PanelContext, post: ContentPost): string {
  const { env } = ctx;
  if (post.media.video && mediaExists(env, post.media.video)) return `<video src="${mediaPath(env, post.media.video)}"${post.media.cover && mediaExists(env, post.media.cover) ? ` poster="${mediaPath(env, post.media.cover)}"` : ""} controls preload="metadata" class="reel"></video>`;
  const slides = (post.media.slides ?? []).filter((slide) => mediaExists(env, slide));
  if (slides.length > 0) return `<div class="strip">${slides.map((slide) => `<a href="${mediaPath(env, slide)}" target="_blank"><img src="${mediaPath(env, slide)}" alt="Slide"></a>`).join("")}</div>`;
  const got = [post.media.image, ...(post.media.clips ?? [])].filter((item) => item && mediaExists(env, item)).length;
  return got > 0 ? `<p class="muted">Mídia do Gemini: ${got} arquivo(s) baixado(s)${post.kind === "reel" ? ` de ${(post.media.clips ?? []).length} cenas` : ""}</p>` : "";
}

function postCard(ctx: PanelContext, post: ContentPost): string {
  const status = STATUS[post.status];
  const open = !["published", "publishing", "skipped"].includes(post.status);
  const pillar = pillarOf(ctx.config, post.pillar)?.name ?? post.pillar;
  const hookName = ctx.config.hookTypes.find((hook) => hook.key === post.hookType)?.name;
  const format = post.kind === "reel" ? ctx.config.reelFormats.find((item) => item.key === post.format) : undefined;
  const formatLabel = format ? (format.episode && post.episode ? `${format.name.split(" (")[0]}, parte ${post.episode}` : format.name) : null;
  const actions = open
    ? [
        post.status === "ready" ? button(post.id, "publish", "Publicar agora", "Publicar este post agora no Instagram?") : "",
        post.status === "failed" ? button(post.id, "retry", "Tentar de novo") : "",
        post.status === "failed" && post.containerId ? button(post.id, "published", "Saiu no Instagram", "Confirmou no Instagram que este post saiu?") : "",
        button(post.id, "rewrite", "Refazer", "Escrever este post de novo do zero (mesmo tema e horário)?"),
        button(post.id, "skip", "Pular", "Pular este post? Ele não será publicado."),
      ].join("")
    : "";
  return `<section class="card">
<div class="row"><div class="grow">
<div class="tags"><b class="cap">${esc(WEEKDAY(ctx.env.TIME_ZONE).format(post.scheduledAt))}</b> <span class="muted">${esc(TIME(ctx.env.TIME_ZONE).format(post.scheduledAt))}</span>
<span class="badge accent">${post.kind === "reel" ? "Reel" : "Carrossel"}</span>${formatLabel ? `<span class="badge accent">${esc(formatLabel)}</span>` : ""}<span class="badge">${esc(pillar)}</span>${hookName ? `<span class="badge">gancho: ${esc(hookName)}</span>` : ""}<span class="badge ${status.tone}">${esc(status.label)}</span></div>
<p class="hook">${esc(post.hook ?? post.topic)}</p><p class="muted">${esc(post.topic)}</p>
${post.error ? `<p class="bad">${esc(post.error)}</p>` : ""}
${post.permalink ? `<a href="${esc(post.permalink)}" target="_blank" class="link">Ver no Instagram</a>` : ""}
${post.metrics ? `<p class="muted">${[["visualizações", post.metrics.views ?? post.metrics.reach], ["envios", post.metrics.shares], ["salvos", post.metrics.saved], ["interações", post.metrics.interactions]].filter(([, value]) => value !== null && value !== undefined).map(([label, value]) => `<b>${Number(value).toLocaleString("pt-BR")}</b> ${label}`).join(" · ")}</p>` : ""}
</div><div class="actions">${actions}</div></div>
${preview(ctx, post)}
${post.caption && open ? `<details><summary class="muted">Legenda</summary><p class="caption">${esc(post.caption)}</p></details>` : ""}
</section>`;
}

export async function renderPanel(ctx: PanelContext): Promise<string> {
  const { db, env, config } = ctx;
  const now = new Date();
  const today = localClock(now, env.TIME_ZONE).dateKey;
  const upcoming = postsBetween(db, new Date(now.getTime() - DAY_MS), new Date(now.getTime() + (config.planDaysAhead + 1) * DAY_MS));
  const published = db
    .select()
    .from(contentPosts)
    .where(eq(contentPosts.status, "published"))
    .orderBy(desc(contentPosts.publishedAt))
    .limit(6)
    .all()
    .filter((post) => !upcoming.some((item) => item.id === post.id));
  const paused = contentPaused(db);
  const accounts = geminiAccounts(env);
  const many = accounts.length > 1;
  const geminiOpen = await Promise.all(accounts.map((account) => probeBrowser(account.cdpUrl)));
  const photos = ownerPhotos(env).length;
  const videosToday = accounts.map((account) => geminiUsedToday(db, "video", today, account.key));
  const accountLine = accounts
    .map((account, index) => {
      const state = geminiBlockedUntil(db, "video", account.key, now) ? "limite do dia atingido" : geminiDownUntil(db, account.key, now) ? "fora do ar" : `${videosToday[index]}/${config.maxVideosPerDay} vídeos`;
      return many ? `conta ${account.key}: ${state}` : state;
    })
    .join(" · ");
  const openAlerts = db.select().from(alerts).where(isNull(alerts.acknowledgedAt)).orderBy(desc(alerts.id)).limit(10).all();
  const checks: Array<[boolean, string, string]> = [
    [config.enabled, "Conteúdo ligado", '"enabled" está false no config/conteudo.json'],
    [Boolean(env.OPENAI_API_KEY), "Chave da OpenAI", "coloque OPENAI_API_KEY no .env"],
    ...accounts.map((account, index): [boolean, string, string] => [
      geminiOpen[index],
      `Chrome do Gemini${many ? ` da conta ${account.key}` : ""} aberto`,
      `abra o LIGAR-CONTEUDO (ou o abrir-chrome-gemini${account.key === "1" ? "" : ` ${account.key}`}) e entre na conta Google`,
    ]),
    [hasMetaCredentials(env), `Token da Meta de ${config.brand.handle}`, "preencha INSTAGRAM_TOKEN e INSTAGRAM_ACCOUNT_ID no .env"],
    [Boolean(publicBaseUrl(env)), "Túnel aberto (a Meta baixa os arquivos por ele)", "o LIGAR-CONTEUDO abre o túnel"],
    ...(config.pillars.some((pillar) => pillar.usesOwnerPhoto) ? [[photos > 0, `Fotos de obra (${photos})`, "coloque fotos de obras da Guide em content/fotos"] as [boolean, string, string]] : []),
  ];
  const stat = (label: string, value: string, hint: string, tone = "") => `<div class="stat"><div class="label">${esc(label)}</div><div class="value ${tone}">${esc(value)}</div><div class="muted">${esc(hint)}</div></div>`;

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>Conteúdo ${esc(config.brand.handle)}</title><style>
:root{--bg:#0b0906;--panel:#151210;--raised:#1f1a16;--line:#2e2620;--text:#f3efe9;--muted:#a59d94;--accent:#fe7121;--ok:#3dbe7a;--warn:#e9b44c;--bad:#ef5b5b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 60px}h1{margin:0;font-size:26px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:28px 0 10px}
.head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:18px}.muted{color:var(--muted)}.bad{color:var(--bad)}.link{color:var(--accent)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:12px}.stat,.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
.label{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.value{font-size:24px;font-weight:700;margin-top:4px}.value.ok{color:var(--ok)}.value.warn{color:var(--warn)}.value.accent{color:var(--accent)}
.card{margin-bottom:12px}.row{display:flex;flex-wrap:wrap;gap:12px}.grow{flex:1;min-width:240px}.actions{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start}.actions form{margin:0}
.tags{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.cap{text-transform:capitalize}.hook{font-weight:700;margin:8px 0 2px}
.badge{display:inline-block;border:1px solid var(--line);background:var(--raised);color:var(--muted);border-radius:999px;padding:1px 9px;font-size:12px}.badge.accent{color:var(--accent);border-color:#fe712166}.badge.ok{color:var(--ok);border-color:#3dbe7a66}.badge.bad{color:var(--bad);border-color:#ef5b5b66}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--raised);color:var(--text);padding:8px 14px}button.primary{background:var(--accent);color:#0b0906;border-color:var(--accent);font-weight:700}button.small{padding:4px 10px;font-size:13px}button:hover{border-color:var(--accent)}
.strip{display:flex;gap:8px;overflow-x:auto;margin-top:10px}.strip img{width:128px;aspect-ratio:4/5;object-fit:cover;border-radius:8px;border:1px solid var(--line)}.reel{width:170px;aspect-ratio:9/16;border-radius:8px;margin-top:10px;background:#000}
.caption{white-space:pre-wrap}ul{list-style:none;padding:0;margin:0}li{margin:4px 0}details{margin-top:10px}.empty{border:1px dashed var(--line);border-radius:12px;padding:24px;text-align:center;color:var(--muted)}
</style></head><body><main>
<div class="head"><div><h1>Conteúdo ${esc(config.brand.handle)}</h1><p class="muted">Planeja a semana variando os pilares, escreve com a IA, pede ao Gemini a capa e as cenas dos Reels, desenha e publica no horário.</p></div>
<form method="post" action="/acao"><input type="hidden" name="action" value="${paused ? "resume" : "pause"}"><button class="${paused ? "primary" : ""}">${paused ? "Retomar conteúdo" : "Pausar conteúdo"}</button></form></div>
<div class="stats">
${stat("Situação", paused ? "Pausado" : "Rodando", config.autoPublish ? "Publica sozinho no horário" : "Espera você clicar em Publicar", paused ? "warn" : "ok")}
${stat("Vídeos do Gemini hoje", `${videosToday.reduce((sum, count) => sum + count, 0)} / ${config.maxVideosPerDay * accounts.length}`, accountLine, "accent")}
${stat("Próximos dias", String(upcoming.filter((post) => post.scheduledAt > now && post.status !== "skipped").length), "posts planejados")}
${stat("Custo da IA no mês", `US$ ${monthToDateSpend(db).toFixed(2)}`, `teto US$ ${env.OPENAI_MONTHLY_BUDGET_USD}`)}
</div>
<section class="card"><div class="label" style="margin-bottom:8px">Checklist</div><ul>${checks
    .map(([ok, label, fix]) => `<li><span class="badge ${ok ? "ok" : "bad"}">${ok ? "OK" : "Falta"}</span> ${esc(label)}${ok ? "" : ` <span class="muted">: ${esc(fix)}</span>`}</li>`)
    .join("")}</ul></section>
${
  openAlerts.length > 0
    ? `<h2>Avisos</h2>${openAlerts
        .map((alert) => `<section class="card row"><div class="grow">${esc(alert.message)}</div><form method="post" action="/acao"><input type="hidden" name="action" value="ack"><input type="hidden" name="alertId" value="${alert.id}"><button class="small">Ok, entendi</button></form></section>`)
        .join("")}`
    : ""
}
<h2>Agenda</h2>
${upcoming.length === 0 ? '<p class="empty">A semana ainda não foi planejada. Com o sistema ligado, isso acontece em alguns minutos.</p>' : upcoming.map((post) => postCard(ctx, post)).join("")}
${published.length > 0 ? `<h2>Últimos publicados</h2>${published.map((post) => postCard(ctx, post)).join("")}` : ""}
</main></body></html>`;
}

export function startPanel(ctx: PanelContext, host = "127.0.0.1"): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      if (url.pathname.startsWith("/api/content/media/") && (req.method === "GET" || req.method === "HEAD")) return serveMedia(ctx, url.pathname, req.method === "HEAD", res);
      if (!authorized(req, ctx.env.PANEL_PASSWORD)) {
        return void res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Conteudo", charset="UTF-8"' }).end("Autenticação necessária");
      }
      if (req.method === "POST" && url.pathname === "/acao") {
        act(ctx, await readForm(req));
        return void res.writeHead(303, { location: "/" }).end();
      }
      if (req.method === "GET" && url.pathname === "/") {
        return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(await renderPanel(ctx));
      }
      res.writeHead(404).end("não encontrado");
    } catch (error) {
      logger.error("panel error", { error });
      if (!res.headersSent) res.writeHead(500).end("erro");
    }
  });
  return new Promise((resolve) => server.listen(ctx.env.PORT, host, () => resolve(server)));
}
