import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Deterministic stand-in for the OpenAI Responses API. It answers by schema name with
 * plausible structured output so the real SDK, cost tracking and guards run end to end.
 */
export interface FakeOpenAI {
  baseUrl: string;
  speech: Array<{ input: string; voice: string; model: string }>;
  requests: Array<{ schema: string; model: string; input: string; instructions: string; images: number }>;
  failNext: (count: number) => void;
  close: () => Promise<void>;
}

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from < 0) return "";
  const rest = text.slice(from + start.length);
  const to = rest.indexOf(end);
  return to < 0 ? rest : rest.slice(0, to);
}

/** Content arm: one topic per "NEW SLOTS" line; a dash in the first draft when asked to test the guard. */
function contentPlan(input: string) {
  const lines = between(input, "NEW SLOTS:\n", "\n\nReturn").split("\n").filter((line) => /^\d+\. /.test(line));
  return {
    posts: lines.map((line) => {
      const index = Number(line.split(".")[0]);
      return { index, topic: `Tema ${index} sobre orçamento de esquadria`, angle: "o que o vendedor faz depois de mandar o orçamento", hook: `Gancho ${index}: o orçamento esfriou` };
    }),
  };
}

function carousel(instructions: string, rejected: boolean) {
  const quote = instructions.includes('kind "quote"');
  const dash = instructions.includes("TOPIC: DASH") && !rejected ? " — " : ", ";
  if (quote) {
    return {
      hook: "Orçamento sem retorno é venda perdida",
      slides: [
        { kind: "quote", title: `Orçamento sem retorno${dash}venda perdida.`, body: "Guide Vidro e Alumínio", stepNumber: null },
        { kind: "cta", title: "Manda VENDER no Direct", body: "Te mostro como.", stepNumber: null },
      ],
      caption: "Quem não volta no cliente perde a obra.\n\nManda VENDER no Direct.",
      hashtags: ["#esquadrias", "aluminio", "#vendas"],
      imagePrompt: "owner photo",
    };
  }
  return {
    hook: "Seu orçamento esfria em 48 horas",
    slides: [
      { kind: "cover", title: `Seu orçamento esfria em 48 horas${dash}veja como evitar`, body: "3 passos para fechar mais", stepNumber: null },
      { kind: "step", title: "Responda no mesmo dia", body: "Quem pede orçamento chama três empresas.", stepNumber: 1 },
      { kind: "step", title: "Marque a medição", body: "Visita marcada vira compromisso.", stepNumber: 2 },
      { kind: "step", title: "Combine o retorno", body: "Follow-up com data marcada.", stepNumber: 3 },
      { kind: "cta", title: "Manda VENDER no Direct", body: "Te mostro como organizar.", stepNumber: null },
    ],
    caption: "Orçamento parado esfria.\n\nManda VENDER no Direct.",
    hashtags: ["#esquadrias", "#vendas"],
    imagePrompt: "Aluminium window factory office at dusk",
  };
}

function reelScript(instructions: string) {
  const clips = Number(/(\d+) AI video scenes/.exec(instructions)?.[1]) || 3;
  return {
    hook: "Perdeu 18 janelas por um vou pensar",
    title: "O erro que esfria o orçamento",
    scenes: Array.from({ length: clips }, (_, index) => ({
      beat: `Ato ${index + 1}`,
      videoPrompt: `Scene ${index + 1}: the person from the reference image in the factory office`,
      narration:
        index === 0
          ? "O Marcos, dono de uma esquadria, mandou o orçamento de dezoito janelas na segunda e ficou esperando o cliente responder sozinho."
          : `Na parte ${index + 1} da história, o Marcos mudou o jeito de acompanhar cada orçamento da equipe e o cliente respondeu na hora.`,
    })),
    summary: "O Marcos perdeu a obra das dezoito janelas e prometeu mudar.",
    shareReason: "Todo dono de esquadria já viveu isso",
    caption: "Orçamento sem retorno vira venda do concorrente.\n\nManda VENDER no Direct.",
    hashtags: ["#esquadrias"],
  };
}

/** How many photos the photo-post prompt lists ("Foto 1 (antes)", "Foto 2"...). */
function photoCount(instructions: string): number {
  return (instructions.match(/^Foto \d+/gm) ?? []).length || 1;
}

function photoCarousel(instructions: string) {
  const count = photoCount(instructions);
  const noCta = instructions.includes("This post has NO call to action");
  return {
    topic: "Antes e depois da varanda",
    hook: "A varanda mudou assim",
    slides: [
      { kind: "cover", photo: count, tag: "", title: "Do ferro ao vidro: a varanda mudou assim", body: "Arrasta para ver o antes" },
      ...Array.from({ length: count }, (_, index) => ({ kind: "photo", photo: index + 1, tag: index === 0 ? "ANTES" : "DEPOIS", title: `Foto ${index + 1}`, body: "O que mudou nesta parte da obra." })),
      ...(noCta ? [] : [{ kind: "cta", photo: null, tag: "", title: "Quer a sua assim?", body: "Chama no WhatsApp ou manda ORÇAMENTO no Direct." }]),
    ],
    caption: "A varanda tinha guarda-corpo de ferro.\n\nChama no WhatsApp ou manda ORÇAMENTO no Direct.",
    hashtags: ["#guardacorpo", "#antesedepois"],
  };
}

function photoReel(instructions: string) {
  const count = photoCount(instructions);
  return {
    topic: "Reel da varanda",
    hook: "Olha o que virou essa varanda",
    title: "Antes e depois da varanda",
    scenes: Array.from({ length: Math.min(count, 3) }, (_, index) => ({
      photo: index + 1,
      narration: index === 0 ? "Essa varanda tinha um guarda-corpo de ferro pesado que tampava toda a vista da casa." : "Agora o guarda-corpo é de vidro na torre e a vista da varanda ficou livre de verdade.",
    })),
    caption: "Antes e depois da varanda.\n\nChama no WhatsApp ou manda ORÇAMENTO no Direct.",
    hashtags: ["#guardacorpo"],
  };
}

let reviews = 0;

function outputFor(schema: string, input: string, instructions: string) {
  switch (schema) {
    case "content_plan":
      return contentPlan(input);
    case "carousel":
      return carousel(instructions, input.includes("previous draft was rejected"));
    case "reel":
      return reelScript(instructions);
    case "photo_carousel":
      return photoCarousel(instructions);
    case "photo_reel":
      return photoReel(instructions);
    case "reel_review": {
      // The first review of a post asks for changes; the rewrite passes.
      const fixed = input.includes('"hook": "Perdeu 18 janelas') && reviews++ % 2 === 1;
      const score = fixed ? 8 : 5;
      return {
        scores: { hook: score, promise: score, context: score, concreteness: score, pace: score, ending: score, share: score, visuals: score },
        problems: fixed ? [] : ["scene 3 shows no result"],
      };
    }
    default:
      return {};
  }
}

/** `speechFile`: an MP3 returned by the text-to-speech endpoint. */
export async function startFakeOpenAI(speechFile?: string): Promise<FakeOpenAI> {
  const requests: FakeOpenAI["requests"] = [];
  const speech: FakeOpenAI["speech"] = [];
  let failures = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (failures > 0) {
        failures -= 1;
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "fake outage" } }));
        return;
      }
      if (req.url?.endsWith("/audio/speech")) {
        const spoken = JSON.parse(raw || "{}") as { input: string; voice: string; model: string };
        speech.push(spoken);
        res.writeHead(200, { "content-type": "audio/mpeg" }).end(speechFile ? readFileSync(speechFile) : Buffer.alloc(0));
        return;
      }
      const body = JSON.parse(raw || "{}") as { model: string; input: unknown; instructions: string; text: { format: { name: string } } };
      const schema = body.text?.format?.name ?? "unknown";
      // With pictures, the input is a message whose parts are the text and the images.
      const parts = Array.isArray(body.input) ? ((body.input[0] as { content?: Array<{ type: string; text?: string }> })?.content ?? []) : [];
      const input = typeof body.input === "string" ? body.input : parts.filter((part) => part.type === "input_text").map((part) => part.text ?? "").join("\n");
      const images = parts.filter((part) => part.type === "input_image").length;
      requests.push({ schema, model: body.model, input, instructions: body.instructions, images });
      const text = JSON.stringify(outputFor(schema, input, body.instructions ?? ""));
      const inputTokens = Math.ceil((input.length + (body.instructions ?? "").length) / 4);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: `resp_${requests.length}`,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: body.model,
          output: [{ id: `msg_${requests.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
          usage: { input_tokens: inputTokens, output_tokens: 60, total_tokens: inputTokens + 60, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    speech,
    failNext: (count) => {
      failures = count;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
