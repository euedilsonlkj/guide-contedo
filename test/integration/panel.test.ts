import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentPosts } from "@/db/schema";
import { mediaPath } from "@/content/files";
import { getPost } from "@/content/posts";
import { startPanel } from "@/panel/server";
import { localClock } from "@/lib/time";
import { createTestDb, testContext } from "../helpers";

describe("panel", () => {
  it("asks the password, serves only signed files publicly and runs the post buttons", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "panel-"));
    const ctx = testContext(createTestDb(), { CONTENT_DIR: dir, PORT: "0", GEMINI_CDP_URL: "http://127.0.0.1:9" });
    mkdirSync(path.join(dir, "posts", "1", "slides"), { recursive: true });
    writeFileSync(path.join(dir, "posts", "1", "slides", "01.jpg"), "jpeg");
    const post = ctx.db
      .insert(contentPosts)
      .values({ account: "principal", kind: "carousel", pillar: "passos", scheduledAt: new Date(Date.now() + 3600_000), topic: "Tema <b>teste</b>", hook: "Gancho", status: "ready", media: { slides: ["posts/1/slides/01.jpg"] } })
      .returning()
      .get();
    const server = await startPanel(ctx);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { authorization: `Basic ${Buffer.from("x:painel-teste-123").toString("base64")}` };
    try {
      expect((await fetch(`${base}/`)).status).toBe(401);
      const page = await fetch(`${base}/`, { headers: auth });
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain("Tema &lt;b&gt;teste&lt;/b&gt;");
      expect(html).toContain("Publicar agora");

      const signed = await fetch(`${base}${mediaPath(ctx.env, "posts/1/slides/01.jpg")}`);
      expect(signed.status).toBe(200);
      expect(signed.headers.get("content-type")).toBe("image/jpeg");
      expect((await fetch(`${base}/api/content/media/${"0".repeat(40)}/posts/1/slides/01.jpg`)).status).toBe(404);
      expect((await fetch(`${base}${mediaPath(ctx.env, "../../etc/passwd")}`)).status).not.toBe(200);

      const skip = await fetch(`${base}/acao`, { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: `postId=${post.id}&action=skip`, redirect: "manual" });
      expect(skip.status).toBe(303);
      expect(getPost(ctx.db, post.id)?.status).toBe("skipped");
      const anonymous = await fetch(`${base}/acao`, { method: "POST", body: `postId=${post.id}&action=retry` });
      expect(anonymous.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("shows the month calendar, the photo form, takes the photos and moves a post", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "panel-"));
    const ctx = testContext(createTestDb(), { CONTENT_DIR: dir, PORT: "0", GEMINI_CDP_URL: "http://127.0.0.1:9" });
    const at = new Date(Date.now() + 3 * 24 * 3600_000);
    const post = ctx.db.insert(contentPosts).values({ account: "principal", kind: "carousel", pillar: "passos", scheduledAt: at, topic: "Tema do calendário", hook: "Gancho do calendário" }).returning().get();
    const day = localClock(at, ctx.env.TIME_ZONE).dateKey;
    const server = await startPanel(ctx);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { authorization: `Basic ${Buffer.from("x:painel-teste-123").toString("base64")}` };
    try {
      const month = await (await fetch(`${base}/?mes=${day.slice(0, 7)}&dia=${day}`, { headers: auth })).text();
      expect(month).toContain('class="days"');
      expect(month).toContain("Gancho do calendário");
      expect(month).toContain("Trocar dia");
      expect(month).toContain("Novo conteúdo com fotos");

      const form = await fetch(`${base}/novo?dia=${day}`, { headers: auth });
      expect(form.status).toBe(200);
      const formHtml = await form.text();
      expect(formHtml).toContain("Antes e depois");
      expect(formHtml).toContain(`value="${day}"`);

      // A tiny valid PNG standing for a photo.
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64").toString("base64");
      const bad = await fetch(`${base}/novo`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ type: "antes_depois", kind: "carousel", when: "next", photos: [{ data: Buffer.from("nope").toString("base64"), label: "antes" }] }) });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toContain("JPG");
      const created = await fetch(`${base}/novo`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ type: "antes_depois", note: "Varanda", kind: "carousel", when: "next", photos: [{ data: png, label: "antes" }, { data: png, label: "depois" }] }) });
      const answer = (await created.json()) as { ok: boolean; postId: number; redirect: string };
      expect(answer.ok).toBe(true);
      expect(answer.redirect).toMatch(/^\/\?mes=\d{4}-\d{2}&dia=\d{4}-\d{2}-\d{2}$/);
      expect(getPost(ctx.db, answer.postId)?.brief?.photos).toHaveLength(2);
      expect(existsSync(path.join(dir, "posts", String(answer.postId), "fotos", "foto-1.png"))).toBe(true);

      const moved = await fetch(`${base}/acao`, { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: `postId=${post.id}&action=move&date=2020-01-01&time=10:00&back=${encodeURIComponent(`/?mes=${day.slice(0, 7)}`)}`, redirect: "manual" });
      expect(moved.status).toBe(303);
      expect(moved.headers.get("location")).toContain("erro=");
      const away = await fetch(`${base}/acao`, { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: `postId=${post.id}&action=move&date=${day}&time=09:15&back=https://evil.example`, redirect: "manual" });
      expect(away.headers.get("location")).toBe("/");
      expect(localClock(getPost(ctx.db, post.id)?.scheduledAt as Date, ctx.env.TIME_ZONE).hour).toBe(9);
    } finally {
      server.close();
    }
  });
});
