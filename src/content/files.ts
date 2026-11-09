import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Env } from "@/lib/env";

/**
 * Where the content arm keeps its files, and how the Meta servers fetch them. Every file of a
 * post lives in CONTENT_DIR/posts/<id>/; the operator's own photos go in CONTENT_DIR/fotos/.
 * The public route /api/content/media/<token>/<path> only serves a file whose token is the
 * HMAC of its path, so the tunnel never exposes anything else.
 */

const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp)$/i;

export function contentRoot(env: Pick<Env, "CONTENT_DIR">): string {
  return path.resolve(env.CONTENT_DIR);
}

export function postDir(env: Pick<Env, "CONTENT_DIR">, postId: number, sub = ""): string {
  const dir = path.join(contentRoot(env), "posts", String(postId), sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function photosDir(env: Pick<Env, "CONTENT_DIR">): string {
  const dir = path.join(contentRoot(env), "fotos");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Folder of the series files (the character's portrait, the same for every Reel). */
export function seriesDir(env: Pick<Env, "CONTENT_DIR">): string {
  const dir = path.join(contentRoot(env), "serie");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The series character's portrait (CONTENT_DIR/serie/personagem.*), made once by Gemini or put
 * there by the operator. Every Reel's scenes are made from it, so the face never changes.
 */
export function seriesPortrait(env: Pick<Env, "CONTENT_DIR">): string | null {
  const dir = seriesDir(env);
  const name = readdirSync(dir)
    .filter((item) => /^personagem\.(jpe?g|png|webp)$/i.test(item))
    .sort()[0];
  return name ? path.join(dir, name) : null;
}

/** The operator's photos (for the "frase" posts), sorted by name. */
export function ownerPhotos(env: Pick<Env, "CONTENT_DIR">): string[] {
  const dir = photosDir(env);
  return readdirSync(dir)
    .filter((name) => PHOTO_EXTENSIONS.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Path relative to CONTENT_DIR, with forward slashes (stored in the database and in URLs). */
export function relativeToRoot(env: Pick<Env, "CONTENT_DIR">, file: string): string {
  return path.relative(contentRoot(env), file).split(path.sep).join("/");
}

export function absoluteFromRoot(env: Pick<Env, "CONTENT_DIR">, relative: string): string | null {
  const root = contentRoot(env);
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

/** True when the file of a post still exists (the panel shows only those). */
export function mediaExists(env: Pick<Env, "CONTENT_DIR">, relative: string | null | undefined): boolean {
  if (!relative) return false;
  const file = absoluteFromRoot(env, relative);
  return Boolean(file && existsSync(/*turbopackIgnore: true*/ file));
}

export function mediaToken(env: Pick<Env, "STATE_ENCRYPTION_KEY">, relative: string): string {
  return createHmac("sha256", env.STATE_ENCRYPTION_KEY).update(`content-media:${relative}`).digest("hex").slice(0, 40);
}

export function verifyMediaToken(env: Pick<Env, "STATE_ENCRYPTION_KEY">, relative: string, token: string): boolean {
  const expected = Buffer.from(mediaToken(env, relative));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** URL path (no host) of a file, for the panel and for Meta. */
export function mediaPath(env: Pick<Env, "STATE_ENCRYPTION_KEY">, relative: string): string {
  return `/api/content/media/${mediaToken(env, relative)}/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Public address of the panel for Meta: CONTENT_PUBLIC_BASE_URL, or the Cloudflare tunnel
 * opened by LIGAR-TUDO (tunel-url.txt). Null when neither exists.
 */
export function publicBaseUrl(env: Pick<Env, "CONTENT_PUBLIC_BASE_URL">, cwd = process.cwd()): string | null {
  if (env.CONTENT_PUBLIC_BASE_URL) return env.CONTENT_PUBLIC_BASE_URL;
  const file = path.join(cwd, "tunel-url.txt");
  if (!existsSync(file)) return null;
  const url = readFileSync(file, "utf8").trim().replace(/\/$/, "");
  return /^https:\/\/[\w.-]+$/.test(url) ? url : null;
}

export function contentTypeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4" } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}
