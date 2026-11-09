import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { alerts, contentPosts, type ContentPost } from "@/db/schema";
import { acknowledgeAlert } from "@/core/journal";
import { absoluteFromRoot, contentTypeOf, mediaExists, mediaPath, ownerPhotos, publicBaseUrl, verifyMediaToken } from "@/content/files";
import { contentPaused, createPhotoPost, geminiAccounts, geminiBlockedUntil, geminiDownUntil, geminiUsedToday, markPublished, movePost, nextFreeDay, PanelInputError, pillarOf, postsBetween, publishNow, retryPost, rewritePost, setContentPaused, skipPost, type SentPhoto } from "@/content/posts";
import { MAX_PHOTOS } from "@/content/ai";
import { zonedInstant } from "@/content/schedule";
import { escapeHtml as esc } from "@/content/render";
import { probeBrowser } from "@/integrations/gemini/web";
import { hasMetaCredentials } from "@/integrations/instagram/publish";
import { monthToDateSpend } from "@/integrations/openai/client";
import type { ContentConfig } from "@/lib/config";
import type { Env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { DAY_MS, localClock } from "@/lib/time";
import { PHOTO_LABELS, type PhotoLabel } from "@/db/schema";

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

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(req, 10_000)) ?? "");
}

/** Runs a panel button; returns a message for the operator when it could not be done. */
function act(ctx: PanelContext, form: URLSearchParams): string | null {
  const action = form.get("action");
  const id = Number(form.get("postId"));
  if (action === "pause" || action === "resume") {
    setContentPaused(ctx.db, action === "pause");
    return null;
  }
  if (action === "ack" && Number.isInteger(Number(form.get("alertId")))) {
    acknowledgeAlert(ctx.db, Number(form.get("alertId")));
    return null;
  }
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    if (action === "retry") retryPost(ctx.db, id);
    else if (action === "rewrite") rewritePost(ctx.db, id);
    else if (action === "skip") skipPost(ctx.db, id);
    else if (action === "publish") publishNow(ctx.db, id);
    else if (action === "published") markPublished(ctx.db, id);
    else if (action === "move") movePost(ctx.db, ctx.env, ctx.config, id, form.get("date") ?? undefined, form.get("time") || undefined);
  } catch (error) {
    if (error instanceof PanelInputError) return error.message;
    throw error;
  }
  return null;
}

/** Only panel paths are followed after a button (never another site). */
function backTo(form: URLSearchParams, message: string | null): string {
  const back = form.get("back") ?? "/";
  const safe = /^\/(\?[\w=&%.-]*)?$/.test(back) ? back : "/";
  if (!message) return safe;
  return `${safe}${safe.includes("?") ? "&" : "?"}erro=${encodeURIComponent(message)}`;
}

const WEEKDAY = (tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit" });
const TIME = (tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" });

function button(postId: number, action: string, label: string, confirm?: string, back = "/"): string {
  return `<form method="post" action="/acao"${confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : ""}><input type="hidden" name="postId" value="${postId}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="back" value="${esc(back)}"><button class="small">${esc(label)}</button></form>`;
}

const HHMM = (at: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

function preview(ctx: PanelContext, post: ContentPost): string {
  const { env } = ctx;
  if (post.media.video && mediaExists(env, post.media.video)) return `<video src="${mediaPath(env, post.media.video)}"${post.media.cover && mediaExists(env, post.media.cover) ? ` poster="${mediaPath(env, post.media.cover)}"` : ""} controls preload="metadata" class="reel"></video>`;
  const slides = (post.media.slides ?? []).filter((slide) => mediaExists(env, slide));
  if (slides.length > 0) return `<div class="strip">${slides.map((slide) => `<a href="${mediaPath(env, slide)}" target="_blank"><img src="${mediaPath(env, slide)}" alt="Slide"></a>`).join("")}</div>`;
  const own = (post.brief?.photos ?? []).filter((photo) => mediaExists(env, photo.file));
  if (own.length > 0) return `<div class="strip">${own.map((photo) => `<figure class="own"><img src="${mediaPath(env, photo.file)}" alt="Foto ${esc(photo.label)}">${photo.label ? `<figcaption>${esc(photo.label)}</figcaption>` : ""}</figure>`).join("")}</div>`;
  const got = [post.media.image, ...(post.media.clips ?? [])].filter((item) => item && mediaExists(env, item)).length;
  return got > 0 ? `<p class="muted">Mídia do Gemini: ${got} arquivo(s) baixado(s)${post.kind === "reel" ? ` de ${(post.media.clips ?? []).length} cenas` : ""}</p>` : "";
}

function postCard(ctx: PanelContext, post: ContentPost, back = "/"): string {
  const status = STATUS[post.status];
  const open = !["published", "publishing", "skipped"].includes(post.status);
  const photoType = post.origin === "photos" ? ctx.config.photoTypes.find((item) => item.key === post.brief?.type) : undefined;
  const pillar = post.origin === "photos" ? `Suas fotos: ${photoType?.name ?? "conteúdo"}` : (pillarOf(ctx.config, post.pillar)?.name ?? post.pillar);
  const hookName = ctx.config.hookTypes.find((hook) => hook.key === post.hookType)?.name;
  const format = post.kind === "reel" ? ctx.config.reelFormats.find((item) => item.key === post.format) : undefined;
  const formatLabel = format ? (format.episode && post.episode ? `${format.name.split(" (")[0]}, parte ${post.episode}` : format.name) : null;
  const actions = open
    ? [
        post.status === "ready" ? button(post.id, "publish", "Publicar agora", "Publicar este post agora no Instagram?", back) : "",
        post.status === "failed" ? button(post.id, "retry", "Tentar de novo", undefined, back) : "",
        post.status === "failed" && post.containerId ? button(post.id, "published", "Saiu no Instagram", "Confirmou no Instagram que este post saiu?", back) : "",
        button(post.id, "rewrite", "Refazer", post.origin === "photos" ? "Escrever o texto deste post de novo (mesmas fotos e horário)?" : "Escrever este post de novo do zero (mesmo tema e horário)?", back),
        button(post.id, "skip", "Pular", "Pular este post? Ele não será publicado.", back),
      ].join("")
    : "";
  return `<section class="card">
<div class="row"><div class="grow">
<div class="tags"><b class="cap">${esc(WEEKDAY(ctx.env.TIME_ZONE).format(post.scheduledAt))}</b> <span class="muted">${esc(TIME(ctx.env.TIME_ZONE).format(post.scheduledAt))}</span>
<span class="badge accent">${post.kind === "reel" ? "Reel" : "Carrossel"}</span>${post.origin === "photos" ? '<span class="badge photo">Com suas fotos</span>' : ""}${formatLabel ? `<span class="badge accent">${esc(formatLabel)}</span>` : ""}<span class="badge">${esc(pillar)}</span>${hookName ? `<span class="badge">gancho: ${esc(hookName)}</span>` : ""}<span class="badge ${status.tone}">${esc(status.label)}</span></div>
<p class="hook">${esc(post.hook ?? post.topic)}</p><p class="muted">${esc(post.topic)}</p>
${post.error ? `<p class="bad">${esc(post.error)}</p>` : ""}
${post.permalink ? `<a href="${esc(post.permalink)}" target="_blank" class="link">Ver no Instagram</a>` : ""}
${post.metrics ? `<p class="muted">${[["visualizações", post.metrics.views ?? post.metrics.reach], ["envios", post.metrics.shares], ["salvos", post.metrics.saved], ["interações", post.metrics.interactions]].filter(([, value]) => value !== null && value !== undefined).map(([label, value]) => `<b>${Number(value).toLocaleString("pt-BR")}</b> ${label}`).join(" · ")}</p>` : ""}
</div><div class="actions">${actions}</div></div>
${preview(ctx, post)}
${post.caption && open ? `<details><summary class="muted">Legenda</summary><p class="caption">${esc(post.caption)}</p></details>` : ""}
${post.origin === "photos" && post.brief?.note ? `<details><summary class="muted">O que você escreveu</summary><p class="caption">${esc(post.brief.note)}</p></details>` : ""}
${
  open || post.status === "skipped"
    ? `<details class="move"><summary class="muted">Trocar dia</summary><form method="post" action="/acao" class="row move-form"><input type="hidden" name="postId" value="${post.id}"><input type="hidden" name="action" value="move"><input type="hidden" name="back" value="${esc(back)}"><label>Dia <input type="date" name="date" required value="${localClock(post.scheduledAt, ctx.env.TIME_ZONE).dateKey}"></label><label>Horário <input type="time" name="time" required value="${HHMM(post.scheduledAt, ctx.env.TIME_ZONE)}"></label><button class="small">Mover</button></form><p class="muted small-text">Se o novo horário já tiver um post do mesmo tipo, os dois trocam de lugar.</p></details>`
    : ""
}
</section>`;
}

const BASE_CSS = `:root{--bg:#0b0906;--panel:#151210;--raised:#1f1a16;--line:#2e2620;--text:#f3efe9;--muted:#a59d94;--accent:#fe7121;--ok:#3dbe7a;--warn:#e9b44c;--bad:#ef5b5b}
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
.max{max-width:1240px}.small-text{font-size:13px}.error{border-color:#ef5b5b88;color:#ffb4b4}
.badge.photo{color:#8cc4ff;border-color:#8cc4ff66}.photo-text{color:#8cc4ff}.accent{color:var(--accent)}
a.button{display:inline-flex;align-items:center;gap:8px;text-decoration:none;border-radius:8px;padding:10px 16px;font-weight:700;background:var(--accent);color:#0b0906}
.cal-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.month{margin:0 6px;font-size:22px;color:var(--text);text-transform:capitalize;letter-spacing:0;min-width:190px}
a.nav{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);text-decoration:none;font-size:26px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--muted)}.legend>span{display:inline-flex;align-items:center;gap:6px}
.dot{flex:none;display:inline-block;width:9px;height:9px;border-radius:50%;margin-top:4px}.dot.ok{background:var(--ok)}.dot.accent{background:var(--accent)}.dot.bad{background:var(--bad)}.dot.plan{border:2px solid var(--muted)}.legend .dot{margin-top:0}
.cal-wrap{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}.cal-main{flex:999 1 620px;min-width:0;overflow-x:auto}.cal-side{flex:1 1 320px;min-width:0}
.cal{min-width:700px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.week,.days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}.week{border-bottom:1px solid var(--line)}.week div{padding:9px 10px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.cell{min-height:118px;padding:8px;display:flex;flex-direction:column;gap:5px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);color:inherit;text-decoration:none;background:var(--panel)}
.cell:hover{background:#1c1714}.cell.blank{background:#100d0b}.cell.past{background:#120f0d}.cell.past .num{color:#8a827a}.cell.sel{background:#2a1d14;box-shadow:inset 0 0 0 2px var(--accent)}
.num{font-weight:600;font-size:13px;align-self:flex-start}.cell.today .num{min-width:26px;height:26px;border-radius:13px;background:var(--accent);color:#0b0906;font-weight:800;display:flex;align-items:center;justify-content:center}
.chip{display:flex;gap:6px;align-items:flex-start;padding:4px 6px;border-radius:6px;background:var(--raised);font-size:12px;line-height:1.3}.chip-text{min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.chip.photo .chip-text{color:#8cc4ff}
a.add{display:block;margin-top:10px;padding:11px;border-radius:8px;border:1px dashed var(--accent);color:var(--accent);text-align:center;font-weight:600;text-decoration:none}
.mini-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:8px 0}.mini-stats b{display:block;font-size:22px}.mini-stats span{font-size:12px}
.move-form{align-items:flex-end;margin-top:8px}.move-form label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);gap:4px}
input,textarea,select{font:inherit;color:var(--text);background:#0f0c0a;border:1px solid var(--line);border-radius:8px;padding:8px 10px}input[type=date],input[type=time]{color-scheme:dark}
figure.own{margin:0;position:relative;flex:none}figure.own img{width:110px}figure.own figcaption{position:absolute;left:6px;top:6px;background:var(--accent);color:#0b0906;font-size:11px;font-weight:800;text-transform:uppercase;padding:2px 6px;border-radius:4px}`;

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const WEEK = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const WEEK_LONG = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function shiftMonth(year: number, month: number, by: number): { year: number; month: number; key: string } {
  const index = year * 12 + (month - 1) + by;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { year: y, month: m, key: `${y}-${String(m).padStart(2, "0")}` };
}

function dotClass(post: ContentPost): string {
  if (post.status === "published") return "dot ok";
  if (post.status === "ready") return "dot accent";
  if (post.status === "failed") return "dot bad";
  return "dot plan";
}

/**
 * The month on a calendar (weeks from Sunday): each day lists its posts; clicking a day opens
 * its posts on the side, with the preview and the buttons.
 */
function calendar(ctx: PanelContext, query: URLSearchParams, now: Date): string {
  const { db, env } = ctx;
  const tz = env.TIME_ZONE;
  const today = localClock(now, tz).dateKey;
  const asked = /^(\d{4})-(\d{2})$/.exec(query.get("mes") ?? "") ?? /^(\d{4})-(\d{2})/.exec(query.get("dia") ?? "") ?? /^(\d{4})-(\d{2})/.exec(today);
  const year = Number(asked?.[1]);
  const month = Math.min(12, Math.max(1, Number(asked?.[2])));
  const current = shiftMonth(year, month, 0);
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const from = zonedInstant(`${current.key}-01`, "00:00", tz);
  const to = zonedInstant(`${next.key}-01`, "00:00", tz);
  const posts = postsBetween(db, from, new Date(to.getTime() - 1)).filter((post) => post.account === ctx.config.account);
  const byDay = new Map<string, ContentPost[]>();
  for (const post of posts) {
    const key = localClock(post.scheduledAt, tz).dateKey;
    byDay.set(key, [...(byDay.get(key) ?? []), post]);
  }
  const keyOf = (day: number) => `${current.key}-${String(day).padStart(2, "0")}`;
  const visible = (key: string) => (byDay.get(key) ?? []).filter((post) => post.status !== "skipped");
  const askedDay = query.get("dia");
  let selected = askedDay && askedDay.startsWith(current.key) && Number(askedDay.slice(8)) <= days ? askedDay : "";
  if (!selected) {
    const keys = Array.from({ length: days }, (_, index) => keyOf(index + 1));
    selected = keys.find((key) => key >= today && visible(key).length > 0) ?? (today.startsWith(current.key) ? today : (keys.find((key) => visible(key).length > 0) ?? keys[0]));
  }
  const link = (key: string) => `/?mes=${current.key}&dia=${key}`;
  const cells: string[] = [];
  for (let blank = 0; blank < firstWeekday; blank += 1) cells.push('<div class="cell blank"></div>');
  for (let day = 1; day <= days; day += 1) {
    const key = keyOf(day);
    const list = visible(key);
    const classes = ["cell", key === selected ? "sel" : "", key === today ? "today" : "", key < today ? "past" : ""].filter(Boolean).join(" ");
    cells.push(
      `<a class="${classes}" href="${link(key)}" aria-label="${day} de ${MONTHS[month - 1]}${list.length ? `, ${list.length} post${list.length > 1 ? "s" : ""}` : ""}"><span class="num">${day}</span>${list
        .map((post) => `<span class="chip${post.origin === "photos" ? " photo" : ""}"><span class="${dotClass(post)}"></span><span class="chip-text">${esc(post.hook ?? post.topic)}</span></span>`)
        .join("")}</a>`,
    );
  }
  const selectedPosts = byDay.get(selected) ?? [];
  const weekday = WEEK_LONG[new Date(`${selected}T12:00:00Z`).getUTCDay()];
  const back = link(selected);
  const upcomingCount = postsBetween(db, now, new Date(now.getTime() + 30 * DAY_MS)).filter((post) => post.account === ctx.config.account && post.status !== "skipped");
  return `<div class="cal-head"><div class="row" style="align-items:center"><a class="nav" href="/?mes=${prev.key}" aria-label="Mês anterior">&lsaquo;</a><h2 class="month">${MONTHS[month - 1]} ${year}</h2><a class="nav" href="/?mes=${next.key}" aria-label="Próximo mês">&rsaquo;</a>${current.key !== today.slice(0, 7) ? '<a class="link" href="/">hoje</a>' : ""}</div>
<div class="legend"><span><span class="dot ok"></span>Publicado</span><span><span class="dot accent"></span>Pronto</span><span><span class="dot plan"></span>Planejado</span><span><span class="dot bad"></span>Parado</span><span class="photo-text">Azul: com suas fotos</span></div></div>
<div class="cal-wrap"><div class="cal-main"><div class="cal"><div class="week">${WEEK.map((name) => `<div>${name}</div>`).join("")}</div><div class="days">${cells.join("")}</div></div></div>
<aside class="cal-side"><div class="card"><div class="label">${esc(weekday)}, ${Number(selected.slice(8))} de ${MONTHS[month - 1]}</div>
${selectedPosts.length === 0 ? '<p class="muted">Nenhum post neste dia.</p>' : ""}
${selected >= today ? `<a class="add" href="/novo?dia=${selected}">+ Conteúdo com fotos neste dia</a>` : ""}</div>
${selectedPosts.map((post) => postCard(ctx, post, back)).join("")}
<div class="card"><div class="label">Próximos 30 dias</div><div class="mini-stats"><div><b>${upcomingCount.length}</b><span class="muted">posts</span></div><div><b class="photo-text">${upcomingCount.filter((post) => post.origin === "photos").length}</b><span class="muted">com suas fotos</span></div><div><b class="accent">${upcomingCount.filter((post) => post.status === "ready").length}</b><span class="muted">prontos</span></div></div>
<p class="muted small-text">O tema de cada dia fica no calendário com até ${ctx.config.planDaysAhead} dias de antecedência. Texto e arte saem até 3 dias antes.</p></div>
</aside></div>`;
}

const LABEL_NAMES: Record<PhotoLabel, string> = { antes: "Antes", depois: "Depois", detalhe: "Detalhe", "": "Sem marca" };

/** "Novo conteúdo com fotos": photos (resized in the browser), kind of content, the story, format and day. */
export function renderNewPhotoPost(ctx: PanelContext, query: URLSearchParams, now = new Date()): string {
  const { config, env, db } = ctx;
  const tz = env.TIME_ZONE;
  const free = nextFreeDay(db, config, tz, now);
  const freeLabel = `${WEEK_LONG[new Date(`${localClock(free, tz).dateKey}T12:00:00Z`).getUTCDay()]} ${new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(free)}, ${HHMM(free, tz)}`;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(query.get("dia") ?? "") ? (query.get("dia") as string) : "";
  const today = localClock(now, tz).dateKey;
  const chip = (name: string, value: string, label: string, checked: boolean, extra = "") => `<label class="pick"><input type="radio" name="${name}" value="${esc(value)}"${checked ? " checked" : ""}${extra}><span>${esc(label)}</span></label>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Novo conteúdo com fotos</title><style>
${BASE_CSS}
main{max-width:920px}.step{display:flex;align-items:center;gap:10px;margin-bottom:12px}.step b{width:28px;height:28px;border-radius:14px;background:var(--accent);color:#0b0906;display:flex;align-items:center;justify-content:center;font-size:14px}.step h2{margin:0;font-size:18px;color:var(--text);text-transform:none;letter-spacing:0}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.ph{display:flex;flex-direction:column;gap:6px}.ph img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:10px;border:1px solid var(--line)}
.labels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}.labels button{padding:6px 0;font-size:12px}.labels button.on{background:var(--accent);color:#0b0906;border-color:var(--accent);font-weight:700}
.tools{display:flex;gap:4px}.tools button{flex:1;padding:6px 0;font-size:13px}
.drop{aspect-ratio:4/5;border-radius:10px;border:2px dashed #4a3f36;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--accent);font-weight:600;text-align:center;padding:10px;cursor:pointer}.drop.over{border-color:var(--accent);background:#2a1d14}
.picks{display:flex;flex-wrap:wrap;gap:8px}.pick input{position:absolute;opacity:0;pointer-events:none}.pick span{display:inline-flex;align-items:center;min-height:44px;padding:10px 16px;border-radius:999px;border:1px solid var(--line);background:var(--raised);font-weight:600;font-size:14px;cursor:pointer}
.pick input:checked+span{border-color:var(--accent);background:#2a1d14;color:var(--accent)}.pick input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
textarea{width:100%;min-height:110px;resize:vertical}.when-date{display:none;gap:12px;flex-wrap:wrap;margin-top:10px}.when-date.on{display:flex}.when-date label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.send{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:12px}.send button{padding:14px 24px;font-size:16px}
</style></head><body><main>
<p><a class="link" href="/">&lsaquo; Voltar ao calendário</a></p>
<h1>Novo conteúdo com suas fotos</h1>
<p class="muted">Coloque as fotos, diga que conteúdo é e o sistema escreve, monta a arte com as suas fotos e agenda. A IA vê as fotos.</p>
<form id="novo">
<section class="card"><div class="step"><b>1</b><h2>Fotos</h2></div>
<div class="photos" id="photos"><label class="drop" id="drop"><span style="font-size:30px;line-height:1">+</span>Adicionar fotos<span class="muted small-text" style="font-weight:400">ou arraste aqui (até ${MAX_PHOTOS})</span><input id="files" type="file" accept="image/*" multiple style="position:absolute;width:1px;height:1px;opacity:0"></label></div>
<p class="muted small-text">Marque cada foto como antes, depois ou detalhe. Use as setas para mudar a ordem. As fotos entram como estão, sem o Gemini mexer.</p></section>
<section class="card"><div class="step"><b>2</b><h2>Que conteúdo é esse?</h2></div>
<div class="picks">${config.photoTypes.map((type, index) => chip("type", type.key, type.name, index === 0)).join("")}</div></section>
<section class="card"><div class="step"><b>3</b><h2><label for="note">Conte sobre a obra</label></h2></div>
<textarea id="note" maxlength="2000" placeholder="Ex.: Varanda de um sobrado. Tiramos o guarda-corpo de ferro e colocamos guarda-corpo de vidro na torre."></textarea>
<p class="muted small-text">O sistema só fala da obra o que estiver escrito aqui. Pode escrever do seu jeito, ele arruma o texto.</p></section>
<section class="card"><div class="step"><b>4</b><h2>Formato e dia</h2></div>
<div class="picks">${chip("kind", "carousel", "Carrossel", true)}${chip("kind", "reel", "Reel com as fotos (zoom, legenda e narração)", false)}</div>
<div class="picks" style="margin-top:10px">${chip("when", "next", `Próximo dia livre: ${freeLabel}`, !day)}${chip("when", "date", "Escolher o dia", Boolean(day))}${chip("when", "now", "Publicar assim que ficar pronto", false)}</div>
<div class="when-date${day ? " on" : ""}" id="whenDate"><label>Dia<input type="date" id="date" min="${today}" value="${day || today}"></label><label>Horário<input type="time" id="time" value="${esc(config.carouselTime)}"></label></div>
<p class="muted small-text">Se o dia escolhido já tiver um post planejado nesse horário, as suas fotos entram no lugar dele.</p></section>
<p id="msg" class="bad" role="alert"></p>
<div class="send"><span class="muted small-text">Fica pronto em poucos minutos e aparece no calendário.</span><button type="submit" class="primary" id="go">Gerar conteúdo</button></div>
</form></main>
<script>
const MAX = ${MAX_PHOTOS}, SIDE = 2048;
const LABELS = ${JSON.stringify(PHOTO_LABELS.map((key) => [key, LABEL_NAMES[key]]))};
const photos = [];
const box = document.getElementById('photos'), drop = document.getElementById('drop'), input = document.getElementById('files'), msg = document.getElementById('msg');
function say(text) { msg.textContent = text || ''; }
function load(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
async function add(files) {
  say('');
  for (const file of files) {
    if (photos.length >= MAX) { say('No máximo ' + MAX + ' fotos por post.'); break; }
    const data = await load(file);
    if (!data) { say('Não consegui abrir ' + file.name + '. Mande em JPG ou PNG.'); continue; }
    const label = photos.length === 0 ? 'antes' : photos.length === 1 ? 'depois' : '';
    photos.push({ data, label });
  }
  draw();
}
function el(tag, attrs, text) { const node = document.createElement(tag); Object.assign(node, attrs || {}); if (text) node.textContent = text; return node; }
function draw() {
  box.querySelectorAll('.ph').forEach((node) => node.remove());
  photos.forEach((photo, index) => {
    const card = el('div', { className: 'ph' });
    card.append(el('img', { src: photo.data, alt: 'Foto ' + (index + 1) }));
    const labels = el('div', { className: 'labels' });
    LABELS.forEach(([key, name]) => {
      const b = el('button', { type: 'button', className: photo.label === key ? 'on' : '' }, name);
      b.setAttribute('aria-pressed', String(photo.label === key));
      b.onclick = () => { photo.label = key; draw(); };
      labels.append(b);
    });
    const tools = el('div', { className: 'tools' });
    const left = el('button', { type: 'button', disabled: index === 0 }, '‹');
    left.setAttribute('aria-label', 'Mover para antes');
    left.onclick = () => { photos.splice(index - 1, 0, photos.splice(index, 1)[0]); draw(); };
    const right = el('button', { type: 'button', disabled: index === photos.length - 1 }, '›');
    right.setAttribute('aria-label', 'Mover para depois');
    right.onclick = () => { photos.splice(index + 1, 0, photos.splice(index, 1)[0]); draw(); };
    const remove = el('button', { type: 'button' }, 'Tirar');
    remove.onclick = () => { photos.splice(index, 1); draw(); };
    tools.append(left, right, remove);
    card.append(el('span', { className: 'muted small-text' }, 'Foto ' + (index + 1)), labels, tools);
    box.insertBefore(card, drop);
  });
  drop.style.display = photos.length >= MAX ? 'none' : '';
}
input.onchange = () => { add(Array.from(input.files)); input.value = ''; };
['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (event) => add(Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'))));
document.querySelectorAll('input[name=when]').forEach((radio) => radio.addEventListener('change', () => document.getElementById('whenDate').classList.toggle('on', radio.value === 'date' && radio.checked)));
document.getElementById('novo').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = (name) => (document.querySelector('input[name=' + name + ']:checked') || {}).value;
  const kind = value('kind');
  if (photos.length === 0) return say('Coloque pelo menos uma foto.');
  if (kind === 'reel' && photos.length < 2) return say('O Reel precisa de pelo menos 2 fotos.');
  const go = document.getElementById('go');
  go.disabled = true; go.textContent = 'Enviando...'; say('');
  try {
    const response = await fetch('/novo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: value('type'), note: document.getElementById('note').value, kind, when: value('when'),
        date: document.getElementById('date').value, time: document.getElementById('time').value,
        photos: photos.map((photo) => ({ data: photo.data.split(',')[1], label: photo.label })),
      }),
    });
    const answer = await response.json().catch(() => ({ error: 'O sistema não respondeu direito. Tente de novo.' }));
    if (!response.ok || answer.error) throw new Error(answer.error || 'Erro ' + response.status);
    location.href = answer.redirect;
  } catch (error) {
    say(error.message);
    go.disabled = false; go.textContent = 'Gerar conteúdo';
  }
});
</script></body></html>`;
}

/** Receives the form of /novo (JSON with the photos in base64) and creates the post. */
export function receivePhotoPost(ctx: PanelContext, raw: string | null, now = new Date()): { status: number; body: Record<string, unknown> } {
  if (raw === null) return { status: 413, body: { error: "As fotos passaram do tamanho máximo. Mande menos fotos." } };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: "Pedido inválido." } };
  }
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const photos: SentPhoto[] = (Array.isArray(data.photos) ? data.photos : []).map((item) => {
    const photo = (item ?? {}) as Record<string, unknown>;
    const label = text(photo.label) as PhotoLabel;
    return { data: Buffer.from(text(photo.data), "base64"), label: (PHOTO_LABELS as readonly string[]).includes(label) ? label : "" };
  });
  try {
    const post = createPhotoPost(ctx.db, ctx.env, ctx.config, { type: text(data.type), note: text(data.note), kind: text(data.kind) as "carousel" | "reel", when: (["next", "date", "now"].includes(text(data.when)) ? text(data.when) : "next") as "next" | "date" | "now", date: text(data.date) || undefined, time: text(data.time) || undefined, photos }, now);
    const day = localClock(post.scheduledAt, ctx.env.TIME_ZONE).dateKey;
    return { status: 200, body: { ok: true, postId: post.id, redirect: `/?mes=${day.slice(0, 7)}&dia=${day}` } };
  } catch (error) {
    if (error instanceof PanelInputError) return { status: 400, body: { error: error.message } };
    throw error;
  }
}

export async function renderPanel(ctx: PanelContext, query = new URLSearchParams()): Promise<string> {
  const { db, env, config } = ctx;
  const now = new Date();
  const today = localClock(now, env.TIME_ZONE).dateKey;
  const upcoming = postsBetween(db, now, new Date(now.getTime() + (config.planDaysAhead + 1) * DAY_MS)).filter((post) => post.account === config.account);
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

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="90">
<title>Conteúdo ${esc(config.brand.handle)}</title><style>
${BASE_CSS}
</style></head><body><main class="max">
<div class="head"><div><h1>Conteúdo ${esc(config.brand.handle)}</h1><p class="muted">Planeja o mês variando os pilares, escreve com a IA, monta as artes (com as suas fotos ou com o Gemini) e publica no horário.</p></div>
<div class="row" style="align-items:center"><a class="button" href="/novo">+ Novo conteúdo com fotos</a><form method="post" action="/acao"><input type="hidden" name="action" value="${paused ? "resume" : "pause"}"><button class="${paused ? "primary" : ""}">${paused ? "Retomar conteúdo" : "Pausar conteúdo"}</button></form></div></div>
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
${query.get("erro") ? `<section class="card error" role="alert">${esc(query.get("erro") as string)}</section>` : ""}
<h2>Calendário</h2>
${upcoming.length === 0 ? '<p class="empty">Os próximos dias ainda não foram planejados. Com o sistema ligado, isso acontece em alguns minutos.</p>' : ""}
${calendar(ctx, query, now)}
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
        const form = await readForm(req);
        const message = act(ctx, form);
        return void res.writeHead(303, { location: backTo(form, message) }).end();
      }
      if (req.method === "POST" && url.pathname === "/novo") {
        const answer = receivePhotoPost(ctx, await readBody(req, 90 * 1024 * 1024));
        return void res.writeHead(answer.status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(answer.body));
      }
      if (req.method === "GET" && url.pathname === "/novo") {
        return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(renderNewPhotoPost(ctx, url.searchParams));
      }
      if (req.method === "GET" && url.pathname === "/") {
        return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(await renderPanel(ctx, url.searchParams));
      }
      res.writeHead(404).end("não encontrado");
    } catch (error) {
      logger.error("panel error", { error });
      if (!res.headersSent) res.writeHead(500).end("erro");
    }
  });
  return new Promise((resolve) => server.listen(ctx.env.PORT, host, () => resolve(server)));
}
