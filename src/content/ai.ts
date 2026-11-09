import { z } from "zod";
import type { Executor } from "@/db/client";
import { recordEvent } from "@/core/journal";
import type { ContentPost } from "@/db/schema";
import { generateStructured } from "@/integrations/openai/client";
import type { Env } from "@/lib/env";
import type { ContentConfig, HookType, Pillar, ReelFormat, Slot } from "./schedule";

/**
 * The AI side of the content arm: choosing a fresh topic for each slot of the week, and
 * writing the carousel or the Reel. Text is always checked by `checkContentText` before it is
 * stored; a draft that breaks a rule is rewritten once with the reasons, then the post stops
 * and waits for the operator.
 */

const MAX_ATTEMPTS = 2;
/** Reels get one more round: writer, editor's notes, rewrite. */
const REEL_ATTEMPTS = 3;

export class ContentRejectedError extends Error {
  constructor(public readonly violations: string[]) {
    super(`content rejected: ${violations.join("; ")}`);
    this.name = "ContentRejectedError";
  }
}

// ---------------------------------------------------------------- guard

const CHECKS: Array<[RegExp, string]> = [
  [/[—–]/, "uses a long dash (— or –); use a comma or a period"],
  [/R\$\s?\d/i, "states a price"],
  [/\d+\s?%/, "states a percentage"],
  [/garanti/i, "promises a guarantee"],
  [/gr[aá]tis|gratuit|teste\s+(gr[aá]tis|de\s+\d+\s+dias)|per[ií]odo\s+de\s+teste|free\s+trial/i, "offers something free or a trial"],
  [/https?:\/\/|www\.|\.com\b|\.br\b|link\s+na\s+bio/i, "contains a link or sends people to a site"],
];

/** Extra words to avoid, from the config (`forbiddenTerms`). */
let extraChecks: Array<[RegExp, string]> = [];

export function setForbiddenTerms(terms: ReadonlyArray<{ pattern: string; reason: string }>): void {
  extraChecks = terms.map((term) => [new RegExp(term.pattern, "i"), term.reason]);
}

export function checkContentText(texts: readonly string[]): string[] {
  const all = texts.join("\n");
  return [...CHECKS, ...extraChecks].filter(([pattern]) => pattern.test(all)).map(([, message]) => message);
}

// ---------------------------------------------------------------- context

function brief(content: ContentConfig): string {
  setForbiddenTerms(content.forbiddenTerms);
  return [
    `VOICE: ${content.voice}`,
    `AUDIENCE: ${content.audience}`,
    `CALL TO ACTION (end of every post): ${content.callToAction}`,
    `FACTS you may state about the company and the owner (nothing else about them):\n${content.facts.map((fact) => `- ${fact}`).join("\n") || "- (none)"}`,
    `OPERATOR RULES:\n${content.rules.map((rule) => `- ${rule}`).join("\n") || "- (none)"}`,
  ].join("\n\n");
}

const HARD_RULES = `Hard rules, never break them:
1. Brazilian Portuguese, natural, like a person who works in the business, not like a guru or an ad.
2. Never invent customers, testimonials, numbers, statistics, results, prices or cases. General advice is fine; claims about the company only from FACTS.
3. Never use the characters "—" or "–". Use commas or periods.
4. No prices, percentages, discounts, guarantees, free trials, links or "link na bio".
5. The call to action never asks a question that can be answered with "no". It tells the person exactly what to do, as in CALL TO ACTION.
6. Never repeat a topic, hook or angle already used in RECENT POSTS.`;

function hookLine(hook: HookType): string {
  return `${hook.key}: ${hook.name}. Opens like "${hook.pattern}". ${hook.use}`;
}

function pillarLine(pillar: Pillar): string {
  return `${pillar.key}: ${pillar.name}. ${pillar.description}`;
}

// ---------------------------------------------------------------- weekly plan

const planSchema = z.object({
  posts: z.array(
    z.object({
      index: z.number().int(),
      topic: z.string(),
      angle: z.string(),
      hook: z.string(),
    }),
  ),
});
export type PlannedTopic = z.infer<typeof planSchema>["posts"][number];

export interface RecentPost {
  date: string;
  kind: string;
  pillar: string;
  topic: string;
  hook: string | null;
}

export async function planTopics(
  db: Executor,
  env: Env,
  content: ContentConfig,
  slots: ReadonlyArray<Slot & { pillar: string; hookType?: string | null; format?: string | null; episode?: number | null }>,
  recent: readonly RecentPost[],
  performance = "",
): Promise<PlannedTopic[]> {
  const pillars = new Map(content.pillars.map((pillar) => [pillar.key, pillar]));
  const hookTypes = new Map(content.hookTypes.map((hook) => [hook.key, hook]));
  const instructions = `You plan the Instagram content calendar of a business account. For each NEW SLOT pick one specific topic inside its pillar, the angle (what makes it useful or new) and the hook (the first line on the cover or the first words on screen, at most 70 characters, it must make the reader stop scrolling).

${HARD_RULES}

Make the week varied: different situations, different pains, different moments of the AUDIENCE's journey. A carousel topic must fit 5 to 7 short slides. A Reel lasts 15 to 30 seconds and makes ONE point, in the format its slot says, always starring the account's character; its hook is on screen in the first 2 seconds and must promise something concrete (a small number, a revelation or a provocation) that the video delivers. Novela slots are the next episode of the series: pick the next problem of the character's story, following the previous episodes.

${brief(content)}

PILLARS:
${content.pillars.map(pillarLine).join("\n")}

${seriesBrief(content)}

REEL FORMATS:
${content.reelFormats.map((format) => `${format.key}: ${format.name}. ${format.description}`).join("\n")}

HOOK TYPES (each slot says which one to use; the hook follows its opening, adapted to the topic and to the trade, in natural Portuguese, never copied word for word every time):
${content.hookTypes.map(hookLine).join("\n")}`;
  const input = `RECENT POSTS (never repeat these topics or hooks):
${recent.map((post) => `- ${post.date} ${post.kind} [${post.pillar}] ${post.topic}${post.hook ? ` | hook: ${post.hook}` : ""}`).join("\n") || "- (none yet)"}

${performance ? `${performance}\n\n` : ""}NEW SLOTS:
${slots
  .map((slot, index) => {
    const hook = hookTypes.get(slot.hookType ?? "");
    const format = slot.format ? content.reelFormats.find((item) => item.key === slot.format) : undefined;
    return `${index}. ${slot.dateKey} ${slot.kind} pillar ${slot.pillar} (${pillars.get(slot.pillar)?.name ?? slot.pillar})${format ? ` | format ${format.key}${format.episode && slot.episode ? ` (parte ${slot.episode})` : ""}` : ""}${hook ? ` | hook type ${hook.key}: opens like "${hook.pattern}"` : ""}`;
  })
  .join("\n")}

Return one item per new slot, with its index.`;

  let feedback = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await generateStructured(db, env, { purpose: "content_plan", schema: planSchema, schemaName: "content_plan", instructions, input: input + feedback, maxOutputTokens: 6000 });
    const byIndex = new Map(result.posts.map((post) => [post.index, post]));
    const missing = slots.map((_, index) => index).filter((index) => !byIndex.has(index));
    const violations = checkContentText(result.posts.flatMap((post) => [post.topic, post.angle, post.hook]));
    if (missing.length === 0 && violations.length === 0) return slots.map((_, index) => byIndex.get(index) as PlannedTopic);
    recordEvent(db, "content_plan_rejected", { attempt, missing, violations });
    feedback = `\n\nYour previous answer was rejected: ${[...violations, ...(missing.length ? [`missing indexes ${missing.join(", ")}`] : [])].join("; ")}. Answer again fixing it.`;
  }
  throw new ContentRejectedError(["the plan kept breaking the rules"]);
}

// ---------------------------------------------------------------- carousel

export const SLIDE_KINDS = ["cover", "text", "step", "quote", "cta"] as const;

const carouselSchema = z.object({
  hook: z.string(),
  slides: z.array(
    z.object({
      kind: z.enum(SLIDE_KINDS),
      title: z.string(),
      body: z.string(),
      stepNumber: z.number().int().nullable(),
    }),
  ),
  caption: z.string(),
  hashtags: z.array(z.string()),
  imagePrompt: z.string(),
});
export type CarouselScript = z.infer<typeof carouselSchema>;
export type Slide = CarouselScript["slides"][number];

export function validateCarousel(script: CarouselScript, pillar: Pillar): string[] {
  const problems: string[] = [];
  const slides = script.slides;
  const min = pillar.usesOwnerPhoto ? 2 : 5;
  const max = pillar.usesOwnerPhoto ? 2 : 8;
  if (slides.length < min || slides.length > max) problems.push(`must have ${min === max ? min : `${min} to ${max}`} slides, has ${slides.length}`);
  if (slides[0]?.kind !== (pillar.usesOwnerPhoto ? "quote" : "cover")) problems.push(`first slide must be "${pillar.usesOwnerPhoto ? "quote" : "cover"}"`);
  if (slides.at(-1)?.kind !== "cta") problems.push('last slide must be "cta"');
  slides.forEach((slide, index) => {
    if (slide.title.length > 80) problems.push(`slide ${index + 1} title over 80 characters`);
    if (slide.body.length > 240) problems.push(`slide ${index + 1} body over 240 characters`);
  });
  if (script.caption.length > 1900) problems.push("caption over 1900 characters");
  return problems;
}

// ---------------------------------------------------------------- reel

/**
 * A Reel is short (15 to 30 seconds, one point per video) and follows a viral format of the
 * config: a novela episode, a POV, "você está fazendo errado", quick tips, before and after or a
 * dramatic documentary. The account's fixed character (config `series`) is the face of every
 * Reel, so people recognize it in the feed. Narrator, subtitles in the brand's boxes, the hook on
 * screen in the first two seconds and, in the novela, a cliffhanger that brings people back.
 */
const reelSchema = z.object({
  /** Big text on screen during the first seconds and on the cover: the promise, not a summary. */
  hook: z.string(),
  /** Header kept on top of the video after the hook, so anyone who lands mid-video knows what it is about. */
  title: z.string(),
  scenes: z.array(
    z.object({
      /** What happens in this beat (for the operator). */
      beat: z.string(),
      /** English prompt of one continuous shot with the character. */
      videoPrompt: z.string(),
      /** Portuguese narration spoken over this scene (about 6 to 8 seconds). */
      narration: z.string(),
    }),
  ),
  /** One sentence of what happened, so the next episodes of the series follow on. */
  summary: z.string(),
  /** Why someone would send this to a colleague (kept for the operator and the learning). */
  shareReason: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
});
export type ReelScript = z.infer<typeof reelSchema> & {
  /** Reels written before the series kept their own character. */
  character?: { name: string; role: string; look: string };
  characterImagePrompt?: string;
};

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export const SCENE_WORDS = { min: 12, max: 22 };
/** About 30 seconds of fast narration at most. */
export const REEL_MAX_WORDS = 70;

export function validateReel(script: ReelScript, format: Pick<ReelFormat, "scenes" | "episode">, characterName: string): string[] {
  const problems: string[] = [];
  if (script.scenes.length !== format.scenes) problems.push(`must have exactly ${format.scenes} scenes, has ${script.scenes.length}`);
  if (script.hook.length > 50) problems.push("hook over 50 characters");
  if (script.title.length > 40) problems.push("title over 40 characters");
  script.scenes.forEach((scene, index) => {
    const words = wordCount(scene.narration);
    if (words < SCENE_WORDS.min || words > SCENE_WORDS.max) problems.push(`scene ${index + 1} narration has ${words} words, it must have ${SCENE_WORDS.min} to ${SCENE_WORDS.max} (one fast scene of 6 to 8 seconds)`);
  });
  const total = script.scenes.reduce((sum, scene) => sum + wordCount(scene.narration), 0);
  if (total > REEL_MAX_WORDS) problems.push(`the whole narration has ${total} words; the Reel must stay under 30 seconds (at most ${REEL_MAX_WORDS} words)`);
  if (format.episode && script.scenes.length > 0 && !script.scenes[0].narration.toLowerCase().includes(characterName.toLowerCase())) {
    problems.push(`the first narration of an episode must name ${characterName}`);
  }
  if (script.caption.length > 1900) problems.push("caption over 1900 characters");
  return problems;
}

export interface EpisodeSummary {
  episode: number;
  title: string;
  summary: string;
}

// ---------------------------------------------------------------- critic

const reviewSchema = z.object({
  scores: z.object({
    hook: z.number(),
    promise: z.number(),
    context: z.number(),
    concreteness: z.number(),
    pace: z.number(),
    ending: z.number(),
    share: z.number(),
    visuals: z.number(),
  }),
  problems: z.array(z.string()),
});
export type ReelReview = z.infer<typeof reviewSchema>;

export const REVIEW_PASS_SCORE = 7;

export function reviewPassed(review: ReelReview): boolean {
  return Object.values(review.scores).every((score) => score >= REVIEW_PASS_SCORE);
}

/**
 * A second AI reads the Reel as a cold viewer scrolling the feed and scores it 0 to 10 on what
 * makes people stop, watch to the end and send. Below 7 in anything, the writer gets the problems back.
 */
export async function reviewReel(db: Executor, env: Env, content: ContentConfig, script: ReelScript, format: ReelFormat): Promise<ReelReview> {
  const instructions = `You are a tough Instagram Reels editor. You judge a 15 to 30 second narrated Reel for this audience: ${content.audience}
Format: ${format.name}. ${format.description}
Watch it in your head as someone scrolling with no idea who made it. Score each item 0 to 10 and list concrete problems (in English, each one with what to change).
- hook: do the on-screen hook and the first spoken words stop this viewer in 2 seconds? It needs a number, a revelation or a provocation, with stakes. A plain description ("he sent the quote") is a 3.
- promise: does the video deliver exactly what the hook promises, with nothing left vague? Clickbait that does not deliver is a 2.
- context: in the first scene, does the viewer understand who it is and what is going on, even without having seen other episodes?
- concreteness: specific details of the trade and of the AUDIENCE's real situation instead of generic words like "organização" or "processo".
- pace: one single point, no filler, no repetition, every sentence moves it forward; nothing that could be cut.
- ending: ${format.episode ? "does it end on a cliffhanger that makes people want the next episode, without resolving it?" : "does it end with a concrete action (exactly what the CALL TO ACTION asks and what the person gets), not a question that can be answered with no?"}
- share: would someone of the AUDIENCE send this to a person they know ("esse é você")?
- visuals: does each videoPrompt show an action that matches what is said at that moment, with a different shot in each scene?`;
  return generateStructured(db, env, {
    purpose: "content_review_reel",
    schema: reviewSchema,
    schemaName: "reel_review",
    instructions,
    input: JSON.stringify({ hook: script.hook, title: script.title, scenes: script.scenes, caption: script.caption }, null, 2),
    maxOutputTokens: 3000,
  });
}

// ---------------------------------------------------------------- writing

export type WrittenPost = { kind: "carousel"; script: CarouselScript } | { kind: "reel"; script: ReelScript };

function hookTypeOf(content: ContentConfig, post: ContentPost): HookType | undefined {
  return content.hookTypes.find((hook) => hook.key === post.hookType);
}

export function formatOf(content: ContentConfig, post: Pick<ContentPost, "format">): ReelFormat {
  return content.reelFormats.find((format) => format.key === post.format) ?? content.reelFormats.find((format) => !format.episode) ?? content.reelFormats[0];
}

function seriesBrief(content: ContentConfig): string {
  const { character } = content.series;
  return `THE ACCOUNT'S CHARACTER (the face of every Reel, always the same person): ${character.name}, ${character.role}.
SERIES "${content.series.name}": ${content.series.premise}`;
}

export async function writePostScript(
  db: Executor,
  env: Env,
  content: ContentConfig,
  post: ContentPost,
  pillar: Pillar,
  recent: readonly RecentPost[],
  episodes: readonly EpisodeSummary[] = [],
): Promise<WrittenPost> {
  const common = `${HARD_RULES}

${brief(content)}

PILLAR: ${pillarLine(pillar)}
${hookTypeOf(content, post) ? `HOOK TYPE: ${hookLine(hookTypeOf(content, post) as HookType)}\nThe hook (and, in a Reel, the first spoken sentence) must follow this hook type.` : ""}
TOPIC: ${post.topic}
ANGLE: ${post.angle ?? "(free)"}
HOOK: ${post.hook ?? "(write one)"}

RECENT POSTS (do not repeat):
${recent.map((item) => `- ${item.topic}`).join("\n") || "- (none)"}`;

  const carouselInstructions = pillar.usesOwnerPhoto
    ? `You write an Instagram carousel of exactly 2 slides. Slide 1 (kind "quote"): title is one strong, short sentence (at most 80 characters) and body is only the signature "${content.quoteSignature || content.brand.wordmark}". Slide 2 (kind "cta"): title with the call to action and body with one short supporting line. imagePrompt: write "owner photo".
Caption: 3 to 6 short paragraphs that develop the sentence, then the call to action. hashtags: 3 to 6 (with "#").`
    : `You write an Instagram carousel of 5 to 7 slides.
Slide 1 kind "cover": title is the hook (at most 70 characters), body is a short subtitle (at most 90 characters).
Middle slides: kind "step" (with stepNumber 1, 2, 3...) for tutorials in steps, otherwise kind "text". Title at most 60 characters, body 1 to 3 short sentences (at most 220 characters). One idea per slide, concrete and practical for the AUDIENCE.
Last slide kind "cta": title with the call to action, body one short supporting line.
Caption: starts with the hook in other words, develops in short paragraphs, ends with the call to action. hashtags: 3 to 6 (with "#").
imagePrompt: in English, a realistic photo for the cover background that fits the topic, following this style: ${content.imageStyle}. Vertical 4:5. No text, no letters, no logos.`;

  const format = formatOf(content, post);
  const character = content.series.character;
  const episodeLines = episodes.length > 0 ? episodes.map((item) => `- Parte ${item.episode} "${item.title}": ${item.summary}`).join("\n") : "- (this is the first episode: introduce who he is in half a sentence)";
  const reelInstructions = `You write a short Instagram Reel of 15 to 30 seconds: ${format.scenes} AI video scenes of about 7 seconds, a narrator in Brazilian Portuguese, subtitles, a header on top and the hook on screen in the first 2 seconds.

FORMAT: ${format.name}. ${format.description}
What each scene does: ${format.structure}
${format.episode ? `This is PARTE ${post.episode ?? 1} of the series "${content.series.name}".
PREVIOUS EPISODES (continue from them, never repeat a situation):
${episodeLines}
It must work for someone who never saw the other parts (half a sentence of recap at most) and END ON A CLIFFHANGER: the last sentence opens a question that only the next part answers (what the customer replied, whether he closes, what the competitor did). Never resolve it in this part. No call to action in the narration: the caption carries it.` : `The last scene ends with the call to action: exactly what to do and what the person gets (CALL TO ACTION), in one short sentence.`}

${seriesBrief(content)}
${character.name} is in every scene (he is the person in the reference image). Other people of the premise may appear. It is an illustrative case with invented people: never say it is a real customer or company. Never prices, percentages, statistics or claims about the company beyond FACTS.

ONE POINT PER VIDEO: one situation, one lesson. Everything that does not serve it is cut.
Clickbait that delivers: the hook promises with a small concrete number ("3 mensagens", "2 dias", "18 janelas"), a revelation ("o erro que ninguém vê") or a provocation ("seu vendedor está te fazendo perder obra"), and the video delivers exactly that. Never a number that is a statistic or a result.
Pace: no breathing room. Short sentences, present tense, concrete, said like a friend telling it. ${SCENE_WORDS.min} to ${SCENE_WORDS.max} words per scene, at most ${REEL_MAX_WORDS} in total. The first spoken words already carry the tension. No filler ("então", "aí", "né", "galera", "fala pessoal"), no marketing words, no lecturing.

hook: the big text on screen in the first 2 seconds and on the cover (at most 45 characters), the promise or what is at stake.${format.episode ? " Do not write \"Parte N\" in it, it is added by the system." : ""}
title: header on top after the hook (at most 36 characters), names the topic.
scenes: exactly ${format.scenes}. For each one:
  beat: what happens, in Portuguese, one line.
  videoPrompt: in English, one continuous realistic shot, vertical 9:16, about 8 seconds, starring "the person from the reference image" (${character.look}). It SHOWS what the narration says at that moment with a clear action and a dynamic camera (fast push in, handheld follow, over the shoulder, whip pan, close-up on the hands or on a phone screen without readable text). Each scene a different shot or place. The light follows the story (cold and tense in the problem, warm in the turn). No text on screen, no logos, no brand names, nobody talking to the camera, only ambient sound.
  narration: Portuguese, ${SCENE_WORDS.min} to ${SCENE_WORDS.max} words.
summary: one sentence in Portuguese of what happened in this video${format.episode ? " and where the cliffhanger left it" : ""}.
shareReason: one line on why someone of the AUDIENCE would send this Reel to a person they know.
caption: first line makes people open it${format.episode ? ` (start with "${content.series.name}, parte ${post.episode ?? 1}.")` : ""}, then the lesson in 2 or 3 short paragraphs, then the call to action. hashtags: 3 to 6 (with "#").`;

  let feedback = "";
  let problems: string[] = [];
  const attempts = post.kind === "reel" ? REEL_ATTEMPTS : MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (post.kind === "carousel") {
      const script = await generateStructured(db, env, {
        purpose: "content_write_carousel",
        schema: carouselSchema,
        schemaName: "carousel",
        instructions: `${carouselInstructions}\n\n${common}`,
        input: `Write the carousel.${feedback}`,
        maxOutputTokens: 6000,
      });
      problems = [
        ...validateCarousel(script, pillar),
        ...checkContentText([script.hook, script.caption, ...script.slides.flatMap((slide) => [slide.title, slide.body])]),
      ];
      if (problems.length === 0) return { kind: "carousel", script };
    } else {
      const script = await generateStructured(db, env, {
        purpose: "content_write_reel",
        schema: reelSchema,
        schemaName: "reel",
        instructions: `${reelInstructions}\n\n${common}`,
        input: `Write the Reel.${feedback}`,
        maxOutputTokens: 6000,
      });
      problems = [
        ...validateReel(script, format, character.name),
        ...checkContentText([script.hook, script.title, script.caption, ...script.scenes.map((scene) => scene.narration)]),
      ];
      if (problems.length === 0) {
        const review = await reviewReel(db, env, content, script, format).catch(() => null);
        recordEvent(db, "content_reel_review", { postId: post.id, attempt, scores: review?.scores ?? null, problems: review?.problems ?? [] });
        // The editor's notes improve the next draft; the last attempt goes out with the best text written.
        if (!review || reviewPassed(review) || attempt === REEL_ATTEMPTS) return { kind: "reel", script };
        feedback = `\n\nAn editor reviewed your previous draft:\n${JSON.stringify(script.scenes.map((scene) => scene.narration))}\nHook: ${script.hook}\nProblems to fix:\n${review.problems.map((item) => `- ${item}`).join("\n")}\nWrite it again fixing all of them.`;
        continue;
      }
    }
    recordEvent(db, "content_write_rejected", { postId: post.id, attempt, problems });
    feedback = `\n\nYour previous draft was rejected for: ${problems.join("; ")}. Write it again avoiding all of them.`;
  }
  throw new ContentRejectedError(problems);
}

/** Caption as it goes to Instagram: the text and the hashtags. */
export function finalCaption(caption: string, hashtags: readonly string[]): string {
  const tags = hashtags
    .map((tag) => tag.trim().replace(/^#*/, "#").replace(/\s+/g, ""))
    .filter((tag) => tag.length > 1)
    .slice(0, 8);
  return tags.length > 0 ? `${caption.trim()}\n\n${tags.join(" ")}` : caption.trim();
}
