import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const DEFAULT_FORMATS = [
  {
    key: "novela",
    name: "Novela (episódio da série)",
    description: "Um episódio curto da série da conta, com o mesmo personagem toda vez. Quem viu um quer ver o próximo, e quem chega agora entende sozinho.",
    structure: "Cena 1: abre no meio da ação, com o que está em jogo hoje (e meia frase de recap se for continuação). Cena 2: dá errado ou complica, com um detalhe concreto do ramo. Cena 3: a virada ou a lição do episódio, e termina num gancho que só se resolve no próximo episódio.",
    scenes: 3,
    episode: true,
    weight: 3,
  },
  {
    key: "pov",
    name: "POV",
    description: "POV: você é o dono da esquadria e... Uma situação que todo dono vive, contada com humor e identificação. O espectador se vê na cena e manda para o sócio.",
    structure: "Cena 1: a situação do POV, que todo dono reconhece. Cena 2: a reação exagerada e verdadeira, com o detalhe que faz rir de nervoso. Cena 3: a virada curta (o que o dono esperto faz) e o pedido do Direct.",
    scenes: 3,
    episode: false,
    weight: 1,
  },
  {
    key: "errado",
    name: "Você está fazendo errado",
    description: "Mostra um jeito comum e errado de fazer algo do comercial da esquadria, por que faz perder a venda e o jeito certo. Provoca e entrega.",
    structure: "Cena 1: o jeito errado, mostrado com o personagem fazendo. Cena 2: o que isso custa (o cliente esfria, o concorrente fecha). Cena 3: o jeito certo, concreto, e o pedido do Direct.",
    scenes: 3,
    episode: false,
    weight: 1,
  },
  {
    key: "dicas",
    name: "3 dicas em 30 segundos",
    description: "Promete um número pequeno de dicas práticas e entrega uma por cena, sem enrolação.",
    structure: "Cena 1: a promessa e a dica 1. Cena 2: a dica 2. Cena 3: a dica 3 e o pedido do Direct. Cada dica é uma ação concreta que dá para fazer hoje.",
    scenes: 3,
    episode: false,
    weight: 1,
  },
  {
    key: "antes_depois",
    name: "Antes e depois",
    description: "O mesmo comercial antes (bagunça, orçamento esquecido) e depois (cada orçamento com data de retorno). O contraste prende e dá vontade de ter o depois.",
    structure: "Cena 1: o antes, com o caos concreto. Cena 2: o depois, a mesma situação resolvida. Cena 3: o que mudou de um para o outro e o pedido do Direct.",
    scenes: 3,
    episode: false,
    weight: 1,
  },
  {
    key: "documentario",
    name: "Documentário dramático",
    description: "Narra o dia a dia do comercial da esquadria como um documentário de natureza, com voz séria e situação engraçada. Humor que vira compartilhamento.",
    structure: "Cena 1: apresenta o personagem no seu habitat, com tom de documentário. Cena 2: o comportamento que faz ele perder a presa (a venda). Cena 3: o que a espécie que sobrevive faz diferente, e o pedido do Direct.",
    scenes: 3,
    episode: false,
    voiceStyle: "Português do Brasil, narrador de documentário de natureza: voz grave, séria e dramática, pausas curtas de suspense, como se contasse algo épico, mesmo sendo uma cena banal do escritório.",
    weight: 1,
  },
];

const DEFAULT_SERIES = {
  name: "A esquadria do Pedro",
  character: {
    name: "Pedro",
    role: "dono de uma pequena empresa de esquadria de alumínio que quer crescer",
    look: "Brazilian man around 38 years old, medium build, short dark hair with a little grey on the sides, short beard, plain dark grey polo shirt without any logo or text, jeans, working in a small aluminium window company in Brazil",
  },
  premise: "O Pedro tem uma empresa de esquadria de alumínio com dois vendedores (o Matheus, novato e animado, e a Carla, experiente e direta). Tudo do comercial roda no WhatsApp e na cabeça dele. Ele investe em anúncio, chovem pedidos de orçamento, mas as vendas não acompanham, e o concorrente da cidade, o Rogério, vive fechando as obras que ele orçou. A cada episódio ele bate num problema do comercial, erra, aprende e muda um pedaço do jeito de vender.",
};

const DEFAULT_PHOTO_TYPES = [
  { key: "antes_depois", name: "Antes e depois", description: "Mostra a mesma obra antes e depois. Alterna as fotos de antes e de depois, com o que mudou escrito em cima de cada uma, e termina com o resultado." },
  { key: "obra_entregue", name: "Obra entregue", description: "Apresenta uma obra pronta: capa com a melhor foto, um slide por foto dizendo o que foi feito ali, e o fechamento." },
  { key: "instalacao", name: "Instalação", description: "Conta a instalação passo a passo, na ordem das fotos." },
  { key: "fabrica", name: "Bastidores da fábrica", description: "Mostra a fabricação por dentro, uma etapa por foto." },
  { key: "produto", name: "Produto em destaque", description: "Um produto só: o que é, onde usar e por quê, usando as fotos para mostrar." },
  { key: "livre", name: "Outro (eu explico)", description: "O operador explica no texto o que quer; siga exatamente o que ele pediu." },
];

const PLACEHOLDER = /\{\{.*?\}\}/;

const textList = z
  .array(z.string())
  .transform((items) => items.map((item) => item.trim()).filter((item) => item.length > 0 && !PLACEHOLDER.test(item)));

/**
 * config/conteudo.json: the Instagram account, the weekly rhythm, the pillars, the voice and
 * the brand. Versioned with the code; no secrets here (they live in .env).
 */
const contentSchema = z
  .object({
    enabled: z.boolean(),
    /** Short name of the Instagram account (one per installation; credentials in .env). */
    account: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
    /** Days (0 = Sunday) and local time of each kind of post. */
    carouselDays: z.array(z.number().int().min(0).max(6)).default([1, 3, 5]),
    carouselTime: z.string().regex(/^\d{2}:\d{2}$/).default("18:30"),
    reelDays: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
    reelTime: z.string().regex(/^\d{2}:\d{2}$/).default("12:00"),
    /** Days ahead that are always planned. */
    planDaysAhead: z.number().int().min(3).max(31).default(7),
    /** Who speaks in the posts and to whom (for the prompts). */
    voice: z.string().min(1),
    audience: z.string().min(1),
    /** What every post ends asking for (e.g. send a DM with a word). */
    callToAction: z.string().min(1),
    /** Rules in the operator's words (vocabulary, things never to say). */
    rules: textList.default([]),
    /** The only facts about the company and the owner the posts may state. */
    facts: textList.default([]),
    /**
     * Words the account never uses (a regular expression, case insensitive, and the reason the
     * writer gets back). A draft with one of them is rewritten.
     */
    forbiddenTerms: z.array(z.object({ pattern: z.string().min(1), reason: z.string().min(1) })).default([]),
    /** Signature under the quote of the photo posts (e.g. the owner's name or the company). */
    quoteSignature: z.string().default(""),
    /**
     * Kinds of viral hook, rotated across the posts like the pillars: each post opens with the
     * pattern of its kind adapted to the topic, and the ones that bring views get more room.
     */
    hookTypes: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
          name: z.string().min(1),
          /** The opening it follows (e.g. "Aposto que você..."). */
          pattern: z.string().min(1),
          /** When and how to use it. */
          use: z.string().min(1),
          weight: z.number().min(0).default(1),
        }),
      )
      .min(1)
      .default(
        [
          { key: "dor", name: "Dor comum", pattern: "Aposto que você...", use: "Aponta um erro do dia a dia do comercial da esquadria que o público comete sem perceber e precisa corrigir já.", weight: 1 },
          { key: "segredo", name: "Curiosidade / segredo", pattern: "Se ninguém te falou isso...", use: "Uma verdade incômoda do mercado de esquadria, um mito ou um conselho sem filtro que ninguém conta.", weight: 1 },
          { key: "tutorial", name: "Promessa / tutorial", pattern: "Hoje eu vou te ensinar...", use: "Vai direto ao ponto e entrega uma solução prática rápida, sem enrolação.", weight: 1 },
          { key: "storytelling", name: "Storytelling / expectativa", pattern: "Eu tô impressionado com o que aconteceu...", use: "Conta um caso, uma virada ou uma descoberta, criando expectativa pelo resultado.", weight: 1 },
          { key: "polemica", name: "Polêmica / posicionamento", pattern: "Eu fiquei muito bravo com...", use: "Reage a uma prática ruim do mercado de esquadria com opinião firme (sem atacar pessoas ou empresas reais).", weight: 1 },
          { key: "aposta", name: "Aposta / desafio", pattern: "Eu aposto que...", use: "Promete um resultado muito claro, que dá vontade de assistir até o fim para ver se é verdade. Nunca promessa falsa, número inventado ou garantia.", weight: 1 },
          { key: "identificacao", name: "Identificação / posicionamento", pattern: "Não tem nada mais profissional que...", use: "Valoriza um comportamento do dono ou do vendedor que o público quer ter, posicionando quem faz assim como referência.", weight: 1 },
        ],
      ),
    pillars: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
          name: z.string().min(1),
          description: z.string().min(1),
          kinds: z.array(z.enum(["carousel", "reel"])).min(1),
          /** Uses one of the operator's photos (folder content/fotos) instead of a Gemini image. */
          usesOwnerPhoto: z.boolean().default(false),
          weight: z.number().min(0).default(1),
        }),
      )
      .min(2),
    brand: z
      .object({
        background: z.string().default("#0B0906"),
        accent: z.string().default("#FE7121"),
        text: z.string().default("#FFFFFF"),
        muted: z.string().default("#B9B4AE"),
        handle: z.string().regex(/^@[\w.]+$/),
        /** Short name on the slides (e.g. "GUIDE"). */
        wordmark: z.string().min(1),
        /** Badge of the last slide and the end of the Reel (empty: "Chama no Direct @handle"). */
        ctaBadge: z.string().default(""),
      }),
    /** Visual direction for the Gemini images and clips (style, light, setting). */
    imageStyle: z.string().min(1),
    /** Narrator of the Reels (OpenAI text-to-speech). */
    narration: z
      .object({
        voice: z.string().default("ash"),
        model: z.string().default("gpt-4o-mini-tts"),
        /** How the narrator speaks, in the operator's words. */
        style: z.string().default("Português do Brasil, homem de uns 35 anos contando um caso que aconteceu para um amigo empresário: ritmo rápido, energia alta, tensão no problema e alívio no resultado, quase sem pausas, sem cara de locutor de rádio."),
        /** Price per minute of narration, for the monthly ceiling. */
        pricePerMinuteUsd: z.number().min(0).default(0.015),
      })
      .default({ voice: "ash", model: "gpt-4o-mini-tts", style: "Português do Brasil, homem de uns 35 anos contando um caso que aconteceu para um amigo empresário: ritmo rápido, energia alta, tensão no problema e alívio no resultado, quase sem pausas, sem cara de locutor de rádio.", pricePerMinuteUsd: 0.015 }),
    /**
     * Viral Reel formats, rotated like the hooks (the ones that bring views and sends get more
     * room). Each Reel is short (15 to 30 seconds, one point per video) and follows its format.
     */
    reelFormats: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
          name: z.string().min(1),
          /** What the format is and why it works, for the writer. */
          description: z.string().min(1),
          /** What each scene does, in order. */
          structure: z.string().min(1),
          /** Gemini clips (about 8 seconds each); 2 to 4 keeps the Reel at 15 to 30 seconds. */
          scenes: z.number().int().min(2).max(4).default(3),
          /** An episode of the series (`series`): continues the plot and ends on a cliffhanger. */
          episode: z.boolean().default(false),
          /** Narrator style for this format, instead of `narration.style`. */
          voiceStyle: z.string().optional(),
          weight: z.number().min(0).default(1),
        }),
      )
      .min(1)
      .default(DEFAULT_FORMATS),
    /** The account's novela: one fixed character (the same face in every Reel) and its premise. */
    series: z
      .object({
        name: z.string().min(1),
        character: z.object({
          name: z.string().min(1),
          role: z.string().min(1),
          /** Fixed look, in English (age, build, hair, plain clothes without logos, workplace). */
          look: z.string().min(1),
        }),
        /** Who else is in the story and what it is about, for every episode. */
        premise: z.string().min(1),
      })
      .default(DEFAULT_SERIES),
    /**
     * Kinds of post made from the operator's own photos (panel "Novo conteúdo com fotos"): the
     * operator picks one, and the description tells the writer how to build it.
     */
    photoTypes: z
      .array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), name: z.string().min(1), description: z.string().min(1) }))
      .min(1)
      .default(DEFAULT_PHOTO_TYPES),
    /** Gemini videos asked per day at most (the account's daily limit). */
    maxVideosPerDay: z.number().int().min(1).max(20).default(3),
    maxImagesPerDay: z.number().int().min(1).max(50).default(10),
    /** Publishes without waiting for anyone; false keeps finished posts waiting for "Publicar" in the panel. */
    autoPublish: z.boolean().default(true),
    /** Hours after the scheduled time a post may still go out (computer was off); then it is skipped. */
    lateToleranceHours: z.number().min(0).max(24).default(10),
  });

export type ContentConfig = z.infer<typeof contentSchema>;

let cached: ContentConfig | undefined;

export function configPath(): string {
  return process.env.CONTENT_CONFIG_PATH ?? path.join(process.cwd(), "config", "conteudo.json");
}

export function getConfig(): ContentConfig {
  if (cached) return cached;
  cached = contentSchema.parse(JSON.parse(readFileSync(configPath(), "utf8")));
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
