import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Stand-in for gemini.google.com/app with the same custom elements, roles and Portuguese
 * labels the agent relies on: rich-textarea, the "Envio e ferramentas" menu with the "Criar
 * imagem" / "Criar vídeo" checkboxes, model-response with generated-image / generated-video,
 * and the download buttons, which really download a file.
 */
export interface FakeGemini {
  origin: string;
  prompts: Array<{ prompt: string; tool: string | null; attached: boolean }>;
  /** The next answer says the daily limit was reached. */
  limitNext: () => void;
  /** The next answer refuses the prompt. */
  refuseNext: () => void;
  close: () => Promise<void>;
}

const PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Google Gemini</title></head><body>
<chat-window>
  <div id="history"></div>
  <input-area-v2>
    <rich-textarea><div class="ql-editor textarea" contenteditable="true" aria-label="Insira um comando para o Gemini"></div></rich-textarea>
    <button aria-label="Envio e ferramentas" id="tools">+</button>
    <button aria-label="Enviar mensagem" id="send">Enviar</button>
  </input-area-v2>
</chat-window>
<div class="cdk-overlay-container" id="overlay"></div>
<script>
let tool = null;
let attached = false;
const overlay = document.getElementById('overlay');
document.getElementById('tools').addEventListener('click', () => {
  overlay.innerHTML = '<div role="menu"><button role="menuitem" id="upload">Enviar arquivos</button><button role="menuitemcheckbox" aria-checked="false" data-tool="image">Criar imagem</button><button role="menuitemcheckbox" aria-checked="false" data-tool="video">Criar vídeo</button></div>';
  for (const item of overlay.querySelectorAll('[data-tool]')) item.addEventListener('click', () => { tool = item.dataset.tool; overlay.innerHTML = ''; });
  document.getElementById('upload').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.addEventListener('change', () => {
      attached = input.files.length > 0;
      document.querySelector('input-area-v2').insertAdjacentHTML('afterbegin', '<uploader-file-preview><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="anexo"></uploader-file-preview>');
    });
    overlay.innerHTML = '';
    input.click();
  });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.innerHTML = ''; });
async function send() {
  const editor = document.querySelector('[contenteditable=true]');
  const prompt = editor.innerText.trim();
  if (!prompt) return;
  editor.innerText = '';
  const res = await fetch('/api/prompt', { method: 'POST', body: JSON.stringify({ prompt, tool, attached }) });
  attached = false;
  const answer = await res.json();
  const response = document.createElement('model-response');
  response.innerHTML = '<message-content>Gerando...</message-content>';
  document.getElementById('history').appendChild(response);
  setTimeout(() => {
    if (answer.kind === 'text') { response.innerHTML = '<message-content>' + answer.text + '</message-content>'; return; }
    if (answer.kind === 'image') {
      response.innerHTML = '<generated-image><single-image><button><img class="image loaded" alt=", gerada com IA" src="/media/image.png"></button></single-image></generated-image>'
        + '<button aria-label="Baixar imagem no tamanho original" id="dl">baixar</button>';
    } else {
      response.innerHTML = '<p>O seu vídeo está pronto!</p><generated-video><video-player><video src="/media/clip.mp4"></video></video-player></generated-video>'
        + '<button aria-label="Baixar vídeo" id="dl">baixar</button>';
    }
    response.querySelector('#dl').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = answer.kind === 'image' ? '/media/image.png' : '/media/clip.mp4';
      a.download = answer.kind === 'image' ? 'Gemini_Generated_Image.png' : 'video.mp4';
      document.body.appendChild(a); a.click(); a.remove();
    });
  }, 1200);
}
document.getElementById('send').addEventListener('click', send);
</script></body></html>`;

export async function startFakeGemini(files: { image: string; video: string }): Promise<FakeGemini> {
  const prompts: FakeGemini["prompts"] = [];
  let next: "limit" | "refuse" | null = null;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/app") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      if (url.pathname === "/media/image.png") return res.writeHead(200, { "content-type": "image/png" }).end(readFileSync(files.image));
      if (url.pathname === "/media/clip.mp4") return res.writeHead(200, { "content-type": "video/mp4" }).end(readFileSync(files.video));
      if (url.pathname === "/api/prompt" && req.method === "POST") {
        const body = JSON.parse(raw) as { prompt: string; tool: string | null; attached: boolean };
        prompts.push(body);
        const json = (value: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
        if (next === "limit") {
          next = null;
          return json({ kind: "text", text: "Você atingiu o limite de vídeos de hoje. Volte amanhã para criar mais." });
        }
        if (next === "refuse") {
          next = null;
          return json({ kind: "text", text: "Desculpe, não posso criar esse conteúdo porque ele pode violar as nossas políticas de uso." });
        }
        return json({ kind: body.tool === "video" || /^Gere um vídeo/.test(body.prompt) ? "video" : "image" });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    prompts,
    limitNext: () => {
      next = "limit";
    },
    refuseNext: () => {
      next = "refuse";
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
