import { describe, expect, it } from "vitest";
import { checkContentText, finalCaption, setForbiddenTerms, validateCarousel, validateReel } from "@/content/ai";
import { getConfig, resetConfigCache } from "@/lib/config";
import { FACEBOOK_GRAPH, graphBaseUrl, INSTAGRAM_GRAPH } from "@/integrations/instagram/publish";
import { absoluteFromRoot, mediaPath, mediaToken, verifyMediaToken } from "@/content/files";
import { geminiAccounts, nextGeminiNeed } from "@/content/posts";
import { learnedPillars, performanceBrief, postScore } from "@/content/learning";
import { subtitleChunks } from "@/content/render";
import { sceneSeconds, subtitleTimings } from "@/content/video";
import { assignFormats, assignHookTypes, assignPillars, upcomingSlots, zonedInstant, type ContentConfig, type Pillar } from "@/content/schedule";
import type { ContentPost } from "@/db/schema";

const TZ = "America/Sao_Paulo";

const pillars: Pillar[] = [
  { key: "historia", name: "História", description: "", kinds: ["carousel"], usesOwnerPhoto: false, weight: 1 },
  { key: "vender", name: "Vender", description: "", kinds: ["carousel", "reel"], usesOwnerPhoto: false, weight: 1.5 },
  { key: "crescer", name: "Crescer", description: "", kinds: ["carousel", "reel"], usesOwnerPhoto: false, weight: 1.5 },
  { key: "frase", name: "Frase", description: "", kinds: ["carousel"], usesOwnerPhoto: true, weight: 1 },
  { key: "dia", name: "Dia a dia", description: "", kinds: ["reel"], usesOwnerPhoto: false, weight: 1 },
];

const content = {
  carouselDays: [1, 3, 5],
  carouselTime: "18:30",
  reelDays: [2, 4, 6],
  reelTime: "12:00",
  pillars,
} as unknown as ContentConfig;

describe("content schedule", () => {
  it("turns a local date and time in São Paulo into the right instant", () => {
    expect(zonedInstant("2026-11-09", "18:30", TZ).toISOString()).toBe("2026-11-09T21:30:00.000Z");
    expect(zonedInstant("2026-01-01", "00:15", TZ).toISOString()).toBe("2026-01-01T03:15:00.000Z");
  });

  it("lists the slots of the coming days and drops the ones already past", () => {
    // Monday 2026-11-09 at 19:00 local: Monday's carousel (18:30) already passed.
    const slots = upcomingSlots(content, TZ, new Date("2026-11-09T22:00:00Z"), 7);
    expect(slots.map((slot) => `${slot.dateKey} ${slot.kind}`)).toEqual([
      "2026-11-10 reel",
      "2026-11-11 carousel",
      "2026-11-12 reel",
      "2026-11-13 carousel",
      "2026-11-14 reel",
    ]);
  });

  it("rotates pillars: never the same twice in a row, and every one shows up", () => {
    const slots = upcomingSlots(content, TZ, new Date("2026-11-08T12:00:00Z"), 28);
    const chosen = assignPillars(pillars, slots, []);
    for (let i = 1; i < chosen.length; i += 1) expect(chosen[i]).not.toBe(chosen[i - 1]);
    for (const pillar of pillars) expect(chosen).toContain(pillar.key);
    slots.forEach((slot, index) => expect(pillars.find((pillar) => pillar.key === chosen[index])?.kinds).toContain(slot.kind));
  });

  it("starts from what was posted recently", () => {
    const slots = upcomingSlots(content, TZ, new Date("2026-11-09T12:00:00Z"), 1);
    expect(slots[0].kind).toBe("carousel");
    expect(assignPillars(pillars, slots, ["historia", "vender", "crescer"])).toEqual(["frase"]);
  });
});

describe("content text guard", () => {
  it("catches the operator's hard rules", () => {
    expect(checkContentText(["Organize o comercial, sem enrolação."])).toEqual([]);
    const problems = checkContentText(["Resultado — 30% a mais", "Teste grátis no link www.site.com.br", "R$ 99"]);
    expect(problems).toHaveLength(5);
  });

  it("allows glass words and blocks the config's forbidden terms", () => {
    setForbiddenTerms([{ pattern: "\\bvexa\\b|\\bcrm\\b", reason: "mentions Vexa" }]);
    try {
      expect(checkContentText(["Guarda-corpo com vidro temperado e box sob medida, jateamento no vidro."])).toEqual([]);
      expect(checkContentText(["Organize tudo num CRM."])).toEqual(["mentions Vexa"]);
    } finally {
      setForbiddenTerms([]);
    }
  });

  it("parses the Guide config shipped in config/conteudo.json", () => {
    const previous = process.env.CONTENT_CONFIG_PATH;
    process.env.CONTENT_CONFIG_PATH = "config/conteudo.json";
    resetConfigCache();
    try {
      const config = getConfig();
      expect(config.brand.wordmark).toBe("GUIDE");
      expect(config.brand.ctaBadge).toContain("97473-9209");
      expect(config.brand.style).toBe("obra");
      expect(config.brand.coverFromPhotos).toBe(true);
      expect(config.quoteSignature).toBe("Guide Vidro e Alumínio");
      expect(config.forbiddenTerms.every((term) => new RegExp(term.pattern, "i") instanceof RegExp)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CONTENT_CONFIG_PATH;
      else process.env.CONTENT_CONFIG_PATH = previous;
      resetConfigCache();
    }
  });

  it("checks the carousel shape", () => {
    const script = { hook: "", caption: "", hashtags: [], imagePrompt: "", slides: [{ kind: "text", title: "a", body: "b", stepNumber: null }] };
    expect(validateCarousel(script as never, pillars[1])).toEqual(expect.arrayContaining(['first slide must be "cover"', 'last slide must be "cta"']));
  });

  it("adds the hashtags to the caption", () => {
    expect(finalCaption("Texto.", ["#vendas", "esquadria", "  ", "#x y"])).toBe("Texto.\n\n#vendas #esquadria #xy");
  });
});

describe("content files", () => {
  const env = { STATE_ENCRYPTION_KEY: "b".repeat(64), CONTENT_DIR: "/tmp/content-root" };

  it("signs every public file URL and refuses others", () => {
    const token = mediaToken(env, "posts/1/slides/01.jpg");
    expect(verifyMediaToken(env, "posts/1/slides/01.jpg", token)).toBe(true);
    expect(verifyMediaToken(env, "posts/1/slides/02.jpg", token)).toBe(false);
    expect(mediaPath(env, "posts/1/slides/01.jpg")).toBe(`/api/content/media/${token}/posts/1/slides/01.jpg`);
  });

  it("never resolves a path outside the content folder", () => {
    expect(absoluteFromRoot(env, "../../etc/passwd")).toBeNull();
    expect(absoluteFromRoot(env, "posts/1/reel.mp4")).toBe("/tmp/content-root/posts/1/reel.mp4");
  });
});

describe("gemini needs", () => {
  const post = (kind: "carousel" | "reel", media: ContentPost["media"]) => ({ kind, status: "written", media }) as ContentPost;

  it("asks the cover photo unless the post uses the owner's photo", () => {
    expect(nextGeminiNeed(post("carousel", {}), pillars[1])).toEqual({ kind: "image", position: 0 });
    expect(nextGeminiNeed(post("carousel", { photo: "fotos/eu.jpg" }), pillars[3])).toBeNull();
    expect(nextGeminiNeed(post("carousel", { imageSkipped: true }), pillars[1])).toBeNull();
  });

  it("asks the character portrait first, then the next missing clip, skipping the ones given up", () => {
    expect(nextGeminiNeed(post("reel", { clips: [null, null] }), pillars[4])).toEqual({ kind: "image", position: 0 });
    expect(nextGeminiNeed(post("reel", { character: "p.png", clips: ["a.mp4", null, null], clipsGivenUp: [1] }), pillars[4])).toEqual({ kind: "video", position: 2 });
    expect(nextGeminiNeed(post("reel", { characterSkipped: true, clips: ["a.mp4", null], clipsGivenUp: [1] }), pillars[4])).toBeNull();
  });
});

describe("story Reel timing", () => {
  it("splits narration into short subtitle lines", () => {
    expect(subtitleChunks("O Marcos mandou o orçamento na segunda, e ficou esperando o cliente responder.")).toEqual([
      "O Marcos mandou o orçamento",
      "na segunda,",
      // A lone last word joins the line before it instead of flashing by alone.
      "e ficou esperando o cliente responder.",
    ]);
  });

  it("shows each line while it is said and stretches the scene to the voice", () => {
    const timings = subtitleTimings(["um dois", "três quatro cinco seis"], 4);
    expect(timings[0].start).toBe(0.05);
    expect(timings[1].start).toBeGreaterThan(timings[0].start);
    expect(timings[1].end).toBeCloseTo(4.25, 1);
    expect(sceneSeconds(4)).toBe(4.25);
    expect(sceneSeconds(1)).toBe(3);
  });
});

describe("learning from the numbers", () => {
  const measured = (pillar: string, views: number, shares = 0) => ({ pillar, metrics: { views, reach: views, shares, saved: 0, interactions: 0 } });

  it("weighs sends and saves above plain views", () => {
    expect(postScore({ views: 1000, reach: 900, shares: 10, saved: 0, interactions: 0 })).toBeGreaterThan(postScore({ views: 1200, reach: 1100, shares: 0, saved: 0, interactions: 0 }));
  });

  it("gives more room to the pillars that perform, within limits", () => {
    const learned = learnedPillars(pillars, [measured("vender", 5000), measured("vender", 4000), measured("historia", 300), measured("historia", 200), measured("dia", 1000)]);
    const weight = (key: string) => learned.find((pillar) => pillar.key === key)?.weight ?? 0;
    expect(weight("vender")).toBeGreaterThan(1.5);
    expect(weight("historia")).toBeCloseTo(0.6, 5);
    expect(weight("crescer")).toBe(1.5);
    expect(learnedPillars(pillars, [measured("vender", 5000)])).toEqual(pillars);
  });

  it("tells the AI the best and worst hooks", () => {
    const rows = [
      { ...measured("vender", 5000, 40), kind: "reel", hook: "Ele perdeu a obra", topic: "a" },
      { ...measured("historia", 100), kind: "carousel", hook: "Nossa história", topic: "b" },
      { ...measured("dia", 800), kind: "reel", hook: "O vendedor sumiu", topic: "c" },
    ] as never;
    const brief = performanceBrief(rows);
    expect(brief.indexOf("Ele perdeu a obra")).toBeLessThan(brief.indexOf("WHAT WORKED WORST"));
    expect(brief.slice(brief.indexOf("WHAT WORKED WORST"))).toContain("Nossa história");
  });
});

describe("Meta token", () => {
  it("talks to the Graph host that accepts the token", () => {
    expect(graphBaseUrl("IGAAabc")).toBe(INSTAGRAM_GRAPH);
    expect(graphBaseUrl("EAAGabc")).toBe(FACEBOOK_GRAPH);
    expect(graphBaseUrl("EAAGabc", "http://127.0.0.1:1/v25.0")).toBe("http://127.0.0.1:1/v25.0");
  });
});

describe("short Reel rules", () => {
  const scene = (narration: string) => ({ beat: "", videoPrompt: "", narration });
  const script = (hook: string, narrations: string[]) => ({ hook, title: "O erro que esfria o orçamento", scenes: narrations.map(scene), summary: "", shareReason: "", caption: "", hashtags: [] });
  const first = "O Rafael mandou o orçamento de dezoito janelas na segunda e o cliente sumiu.";
  const next = "Na quarta o concorrente ligou primeiro, marcou a medição e fechou a obra inteira.";
  const novela = { scenes: 2, episode: true };

  it("accepts a short episode that opens with the character", () => {
    expect(validateReel(script("Perdeu 18 janelas por um vou pensar", [first, next]), novela, "Rafael")).toEqual([]);
  });

  it("asks an episode to name the character in the first scene, but not a POV", () => {
    expect(validateReel(script("x", [next, first]), novela, "Rafael").join()).toContain("must name Rafael");
    expect(validateReel(script("x", [next, first]), { scenes: 2, episode: false }, "Rafael")).toEqual([]);
  });

  it("keeps each scene fast and the whole Reel under 30 seconds", () => {
    expect(validateReel(script("x", ["O Rafael mandou o orçamento.", next]), novela, "Rafael").join()).toContain("12 to 22");
    const long = "O Rafael mandou o orçamento de dezoito janelas na segunda e o cliente sumiu sem dar retorno nenhum.";
    expect(validateReel(script("x", [long, long, long, long]), { scenes: 4, episode: true }, "Rafael").join()).toContain("under 30 seconds");
  });
});

describe("Gemini accounts", () => {
  it("gives each account its own Chrome port", () => {
    const env = { GEMINI_CDP_URL: "http://127.0.0.1:9226", GEMINI_ACCOUNTS: 2, GEMINI_CDP_URLS: undefined } as never;
    expect(geminiAccounts(env)).toEqual([
      { key: "1", cdpUrl: "http://127.0.0.1:9226" },
      { key: "2", cdpUrl: "http://127.0.0.1:9227" },
    ]);
  });
});

describe("hook types", () => {
  const hooks = ["dor", "segredo", "tutorial", "storytelling"].map((key) => ({ key, name: key, pattern: "x", use: "x", weight: 1 }));
  const slots = upcomingSlots(content, TZ, new Date("2026-11-08T12:00:00Z"), 14);

  it("rotates the hook kinds without repeating one in a row and uses all of them", () => {
    const chosen = assignHookTypes(hooks, slots, []);
    for (let i = 1; i < chosen.length; i += 1) expect(chosen[i]).not.toBe(chosen[i - 1]);
    for (const hook of hooks) expect(chosen).toContain(hook.key);
  });

  it("goes first to the kinds not used recently", () => {
    expect(assignHookTypes(hooks, slots.slice(0, 1), ["dor", "segredo", "tutorial"])).toEqual(["storytelling"]);
  });
});

describe("Reel formats", () => {
  const formats = [
    { key: "novela", weight: 3 },
    { key: "pov", weight: 1 },
    { key: "errado", weight: 1 },
  ] as never;
  const slot = (kind: "carousel" | "reel") => ({ kind, at: new Date(), dateKey: "2026-11-09" });

  it("gives formats only to Reels, the novela most often, never the same twice in a row", () => {
    const slots = [slot("reel"), slot("carousel"), ...Array.from({ length: 9 }, () => slot("reel"))];
    const result = assignFormats(formats, slots, []);
    expect(result[1]).toBeNull();
    const reels = result.filter((item): item is string => item !== null);
    expect(reels).toHaveLength(10);
    for (let i = 1; i < reels.length; i += 1) expect(reels[i]).not.toBe(reels[i - 1]);
    expect(reels.filter((item) => item === "novela").length).toBeGreaterThanOrEqual(4);
  });
});
