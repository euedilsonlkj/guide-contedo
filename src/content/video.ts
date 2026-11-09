import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Env } from "@/lib/env";

/**
 * Builds the Reel with ffmpeg: each scene is the Gemini clip (or a slow zoom on the character
 * portrait when the clip is missing) cut to 1080x1920 and to the length of its narration, with
 * the voice over the scene's own sound, punch-in cuts every couple of seconds, the subtitles in
 * the rhythm of the voice, the hook at the start and the ending badge at the end. Everything is joined into one H.264/AAC MP4 (the
 * format the Instagram API asks for), with no static end card, so the video loops.
 */

const FPS = 30;

export function ffmpegPath(env: Pick<Env, "FFMPEG_PATH">): string {
  if (env.FFMPEG_PATH) return env.FFMPEG_PATH;
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const bundled = require("ffmpeg-static") as string | null;
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // Not installed: fall back to the one on the PATH.
  }
  return "ffmpeg";
}

function run(binary: string, args: string[], timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-20_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg did not start (${binary}): ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.split("\n").slice(-6).join(" ").slice(0, 600)}`));
    });
  });
}

/** True when the file has an audio stream (Gemini clips usually do). */
async function hasAudio(binary: string, file: string): Promise<boolean> {
  const output = await run(binary, ["-hide_banner", "-i", file, "-f", "null", "-t", "0.1", "-"]).catch((error: Error) => error.message);
  return /Stream #\d+:\d+.*Audio:/.test(output);
}

const VIDEO_OUT = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS)];
const AUDIO_OUT = ["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"];
const FIT = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=${FPS},setsar=1`;

/** Length in seconds of an audio or video file, read from ffmpeg's own report. */
export async function mediaDuration(env: Pick<Env, "FFMPEG_PATH">, file: string): Promise<number> {
  const output = await run(ffmpegPath(env), ["-hide_banner", "-i", file, "-f", "null", "-"]).catch((error: Error) => error.message);
  const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(output);
  if (!match) throw new Error(`could not read the duration of ${file}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Readies a narration for the Reel: cuts the silence the voice leaves at the start and the end
 * (dead air between scenes is where people swipe away), speeds it up a little and brings it to
 * the loudness Instagram plays at.
 */
export async function prepareNarration(env: Pick<Env, "FFMPEG_PATH">, input: string, output: string, tempo = 1.08): Promise<string> {
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";
  await run(ffmpegPath(env), [
    "-y",
    "-hide_banner",
    "-i",
    input,
    "-af",
    `${trim},areverse,${trim},areverse,atempo=${tempo},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100`,
    "-ac",
    "2",
    ...AUDIO_OUT,
    output,
  ]);
  return output;
}

export interface TimedOverlay {
  /** Transparent PNG of the full frame. */
  file: string;
  start: number;
  end: number;
}

export interface StoryScene {
  /** Gemini clip, or null when it is missing (then `still` is used with a slow zoom). */
  clip: string | null;
  /** Character portrait or brand background. */
  still: string;
  /** Narration MP3 of this scene. */
  narration: string;
  narrationSeconds: number;
  overlays: readonly TimedOverlay[];
}

/** Narration starts a beat after the cut, and the scene breathes a moment after it ends. */
export const VOICE_DELAY = 0.05;
const TAIL = 0.2;

export function sceneSeconds(narrationSeconds: number): number {
  return Math.max(3, Math.round((narrationSeconds + VOICE_DELAY + TAIL) * 100) / 100);
}

/**
 * Times the subtitle chunks of a scene over its narration, proportionally to their length,
 * so each line shows while it is being said.
 */
export function subtitleTimings(chunks: readonly string[], narrationSeconds: number): Array<{ start: number; end: number }> {
  const weights = chunks.map((chunk) => chunk.replace(/\s+/g, "").length + 3);
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let cursor = VOICE_DELAY;
  return weights.map((weight, index) => {
    const start = cursor;
    cursor += (weight / total) * narrationSeconds;
    return { start: Math.round(start * 100) / 100, end: Math.round((index === weights.length - 1 ? cursor + TAIL : cursor) * 100) / 100 };
  });
}

/**
 * Punch-in cuts: every PUNCH_SECONDS the frame jumps between the full shot and a closer one,
 * the quick-cut rhythm that holds attention, without cutting the clip itself.
 */
export const PUNCH_SECONDS = 2.2;
export const PUNCH_ZOOM = 1.12;

function punchZoom(base = "1"): string {
  const segment = Math.round(PUNCH_SECONDS * FPS);
  return `${base}+if(eq(mod(floor(on/${segment}),2),1),${PUNCH_ZOOM - 1},0)`;
}

/** One frame of a video as JPEG (for the Reel's cover). */
export async function extractFrame(env: Pick<Env, "FFMPEG_PATH">, video: string, atSeconds: number, output: string): Promise<string | null> {
  await run(ffmpegPath(env), ["-y", "-hide_banner", "-ss", String(atSeconds), "-i", video, "-frames:v", "1", "-vf", FIT, "-q:v", "3", output]);
  return existsSync(output) ? output : null;
}

async function buildScene(binary: string, scene: StoryScene, out: string): Promise<void> {
  const seconds = sceneSeconds(scene.narrationSeconds);
  const frames = Math.ceil(seconds * FPS);
  const args = ["-y", "-hide_banner"];
  const clipAudio = scene.clip ? await hasAudio(binary, scene.clip) : false;
  if (scene.clip) args.push("-i", scene.clip);
  else args.push("-i", scene.still);
  args.push("-i", scene.narration);
  // Each overlay PNG is decoded once and repeated in memory (decoding it every frame is slow).
  for (const overlay of scene.overlays) args.push("-i", overlay.file);

  const delayMs = Math.round(VOICE_DELAY * 1000);
  const parts: string[] = [];
  parts.push(
    scene.clip
      ? // A clip shorter than the narration holds its last frame; a longer one is cut.
        `[0:v]${FIT},tpad=stop_mode=clone:stop_duration=${seconds},trim=duration=${seconds},setpts=PTS-STARTPTS,zoompan=z='${punchZoom()}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=${FPS},setsar=1[v0]`
      : // No clip: slow push-in on the still, so the scene still moves.
        `[0:v]scale=1188:2112:force_original_aspect_ratio=increase,crop=1188:2112,zoompan=z='${punchZoom("min(1+0.0009*on,1.15)")}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=${FPS},setsar=1,trim=duration=${seconds}[v0]`,
  );
  scene.overlays.forEach((overlay, index) => {
    parts.push(`[${index + 2}:v]loop=loop=-1:size=1:start=0,setpts=N/${FPS}/TB[o${index}]`);
    parts.push(`[v${index}][o${index}]overlay=0:0:format=auto:eof_action=pass:enable='between(t,${overlay.start},${overlay.end})'[v${index + 1}]`);
  });
  const lastVideo = `[v${scene.overlays.length}]`;
  parts.push(`[1:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad,atrim=0:${seconds}[voice]`);
  if (clipAudio) {
    // The scene's own sound stays underneath the voice, low.
    parts.push(`[0:a]aresample=44100,aformat=channel_layouts=stereo,volume=0.12,apad,atrim=0:${seconds}[bed]`);
    parts.push(`[voice][bed]amix=inputs=2:duration=first:normalize=0[a]`);
  } else {
    parts.push(`[voice]anull[a]`);
  }
  args.push("-filter_complex", parts.join(";"), "-map", lastVideo, "-map", "[a]", "-t", String(seconds), ...VIDEO_OUT, ...AUDIO_OUT, out);
  await run(binary, args);
}

export interface StoryReel {
  scenes: readonly StoryScene[];
  workDir: string;
  output: string;
}

/** Builds the narrated story Reel: one part per scene, joined without another encode. */
export async function buildStoryReel(env: Pick<Env, "FFMPEG_PATH">, reel: StoryReel): Promise<string> {
  const binary = ffmpegPath(env);
  const pieces: string[] = [];
  for (let index = 0; index < reel.scenes.length; index += 1) {
    const out = path.join(reel.workDir, `part-${index + 1}.mp4`);
    await buildScene(binary, reel.scenes[index], out);
    pieces.push(out);
  }
  const list = path.join(reel.workDir, "parts.txt");
  writeFileSync(list, pieces.map((piece) => `file '${piece.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  await run(binary, ["-y", "-hide_banner", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", reel.output]);
  return reel.output;
}
