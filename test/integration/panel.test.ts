import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentPosts } from "@/db/schema";
import { mediaPath } from "@/content/files";
import { getPost } from "@/content/posts";
import { startPanel } from "@/panel/server";
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
});
