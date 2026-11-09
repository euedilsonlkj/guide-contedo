# Guide Conteúdo

Instagram no automático para a Guide Vidro e Alumínio: o sistema planeja a semana, escreve os
carrosséis com a IA, pede ao Gemini (no navegador) a foto da capa, desenha as artes na marca
(preto e laranja) e publica no horário pela API oficial da Meta.

É o mesmo motor do vexa-conteudo, com tudo da Guide: pilares, público, chamada para o
WhatsApp ou Direct, fatos permitidos e marca. Roda separado do Vexa: pasta, banco, painel
(porta **3200**), Chromes do Gemini (portas **9236** e **9237**) e túnel próprios
(`cloudflared-guide`). Os dois podem ficar ligados ao mesmo tempo no mesmo computador.

## Instalar (uma vez)

1. Node 24 instalado (https://nodejs.org).
2. Baixe este repositório e dê dois cliques no **instalar.bat** (Windows) ou **instalar.command**
   (Mac). Ele cria o `.env`, mostra a senha do painel e abre o arquivo para você preencher:
   - `OPENAI_API_KEY`: a chave da OpenAI (pode ser a mesma do Vexa).
   - `INSTAGRAM_TOKEN` e `INSTAGRAM_ACCOUNT_ID` do Instagram **da Guide**, com as permissões
     `instagram_business_content_publish` (publicar) e `instagram_business_manage_insights`
     (ler os números de cada post, para o sistema aprender).
3. Coloque **fotos reais de obras da Guide** em `content/fotos` (jpg ou png). Elas viram o fundo
   dos posts de frase.
4. Confira em `config/conteudo.json` o `@` do Instagram (`brand.handle`).

## Todo dia

Dois cliques no **LIGAR-CONTEUDO.bat** (ou **.command**) desta pasta. Ele abre os Chromes do
Gemini da Guide ("Agente Gemini Guide conta 1" e "conta 2"), o túnel e o sistema, e abre o
painel em http://127.0.0.1:3200 (qualquer usuário, senha do `.env`). Deixe as janelas abertas;
para desligar, Ctrl + C.

Na primeira vez, entre na conta Google em cada Chrome do Gemini que abrir. Se usar as mesmas
contas Google do Vexa, o limite diário do Gemini é dividido entre os dois sistemas.

> Atenção: o Google não permite uso automatizado do app do Gemini e pode limitar ou suspender a
> conta. Use de preferência uma conta Google separada, só para isso.

## O que entra no Instagram da Guide

Carrossel seg, qua e sex às 18:30, cada um num pilar em rodízio (os que performam ganham espaço):

- **Guia de compra de esquadria**: quando pedir orçamento, medição do vão, contramarco, como
  comparar orçamentos.
- **Produtos e linhas**: correr, abrir, pivotante, maxi-ar e fixo, persiana integrada, linhas
  Suprema, Suprema Larga e Gold, os 4 sistemas de guarda-corpo.
- **Erros que estragam a esquadria**: o que faz vazar, emperrar ou entortar, e como evitar.
- **Cuidados e manutenção**: trilho, roldana, vedação, limpeza.
- **Frase com foto de obra**: frase curta em cima de uma foto sua de `content/fotos`,
  assinada "Guide Vidro e Alumínio".

Todo post fecha com a chamada nas duas opções: **WhatsApp (11) 97473-9209 ou ORÇAMENTO no
Direct**. Sem travessão, sem preço, sem prazo, sem porcentagem, sem garantia, sem link, sem
inventar obra ou cliente; fatos sobre a Guide só os de `facts`.

## Conteúdo com as suas fotos

No painel, **+ Novo conteúdo com fotos**:

1. Coloque até 8 fotos e marque cada uma como antes, depois, detalhe ou sem marca. As setas mudam
   a ordem. O próprio navegador diminui as fotos antes de mandar.
2. Diga que conteúdo é: antes e depois, obra entregue, instalação, bastidores da fábrica, produto
   em destaque ou outro (você explica). Os tipos ficam em `photoTypes` no config.
3. Conte sobre a obra do seu jeito. A IA vê as fotos e só fala da obra o que estiver escrito ali.
4. Escolha carrossel ou **Reel com as fotos** (zoom em cada foto, legenda e narração, sem Gemini;
   funciona mesmo com os Reels do plano desligados) e o dia: o próximo dia livre, um dia do
   calendário (se já tiver post planejado nesse horário, as fotos entram no lugar dele) ou publicar
   assim que ficar pronto.

O texto sai na hora e a arte em seguida; o post aparece no calendário com a prévia, e dá para
Refazer, Trocar dia, Publicar agora ou Pular.

## Calendário

A página inicial do painel é o calendário do mês: cada dia com os posts (verde publicado,
laranja pronto, contorno planejado, vermelho parado, azul com as suas fotos). Clique no dia para
ver a prévia e os botões, e as setas passam de mês. Os temas ficam planejados `planDaysAhead`
dias à frente (30 na Guide); texto e arte continuam saindo só até 3 dias antes. Em **Trocar dia**,
se o novo horário já tiver um post do mesmo tipo, os dois trocam de lugar.

Os **Reels** estão desligados (`reelDays: []`), como no Vexa. Já ficam prontos para ligar: a
série "A obra da Camila" (alguém construindo a primeira casa, com o mestre de obras e a
arquiteta) e os formatos novela, POV, "você está fazendo errado", 3 dicas e antes e depois.

## O que ele faz

1. **Planeja os próximos 7 dias**: carrossel seg/qua/sex às 18:30 e **Reel todo dia** às 12:00.
   Cada horário recebe um pilar em rodízio (nunca o mesmo duas vezes seguidas) e a IA escolhe o
   tema olhando os últimos 40 posts, para nunca repetir assunto.
   Cada post também recebe um **tipo de gancho viral**, em rodízio (`hookTypes` no config): dor
   comum ("Aposto que você..."), segredo ("Se ninguém te falou isso..."), tutorial ("Hoje eu vou
   te ensinar..."), storytelling, comparação ("Qual é melhor, correr ou abrir?"), aposta e
   identificação. Os tipos que trazem mais visualização e envios ganham mais espaço com o tempo.
   Cada Reel recebe também um **formato viral**, em rodízio (`reelFormats` no config): novela
   (episódio da série, o que mais aparece), POV, "você está fazendo errado", 3 dicas em 30
   segundos e antes e depois. Os formatos que performam ganham espaço.
2. **Escreve** até 3 dias antes: slides, legenda e hashtags, ou o roteiro narrado do Reel.
   Sem travessão, sem preço, sem porcentagem, sem prazo, sem link, sem citar o Vexa ou
   CRM; fatos sobre a empresa só os de `facts`.
3. **Pede ao Gemini**: a foto de fundo da capa do carrossel e as cenas do Reel. Todo Reel tem o
   mesmo personagem, o rosto da conta (`series` no config, por padrão a Camila, que está
   construindo). A foto dela é feita uma vez só e fica em `content/serie/personagem.png`; todas as
   cenas de todos os Reels são feitas a partir dela, então o rosto nunca muda. Se quiser outro
   rosto, troque esse arquivo (ou apague para o Gemini fazer outro). Uma coisa por vez, no máximo
   `maxVideosPerDay` vídeos por dia em cada conta. Se o Gemini avisar que o limite do dia acabou,
   passa para a outra conta ou espera até a meia noite. Se recusar duas vezes, o carrossel segue
   com a capa desenhada. O Reel nunca sai só com a foto: pode faltar no máximo uma cena (vira um
   zoom na foto do Camila); se faltar mais, ele continua pedindo ao Gemini e sai um pouco atrasado
   (até `lateToleranceHours`), e se o Gemini recusar as cenas, ele para no painel para você usar
   Refazer.
4. **Desenha** no método dos 12 passos da visualização:
   - slides 1080x1350 na marca (Montserrat, preto e laranja), com o texto feito por código;
   - Reel curto, de 15 a 30 segundos (2 a 4 cenas, conforme o formato), **um ponto por vídeo**;
   - **novela**: a série "A obra da Camila" anda em episódios ("Parte 1", "Parte 2"...). O
     roteirista recebe o resumo dos episódios anteriores, continua a história e termina num gancho
     que só se resolve no próximo; no fim aparece "Parte N+1 em breve. Segue @guidevidroealuminio";
   - gancho que promete e entrega (número pequeno, revelação ou provocação), na tela nos 2
     primeiros segundos, em caixa branca, com a tag "PARTE N" na novela;
   - **capa** (miniatura do Reel) com um quadro do vídeo e o gancho em letras grandes, no centro,
     para aparecer inteira na grade do perfil; vai junto na publicação;
   - **edição dinâmica**: a cada 2 segundos a imagem dá um zoom de corte, e a voz não tem silêncio
     entre as cenas (eliminar respiro);
   - **legenda em caixa laranja** da marca, em blocos curtos no ritmo da voz (80% assiste sem som),
     o mesmo visual em todo Reel para a conta ser reconhecida no feed;
   - narração em português (voz da OpenAI; o documentário usa voz de narrador dramático);
   - um revisor (segunda IA) dá nota para gancho, promessa entregue, contexto, detalhe, ritmo,
     final (gancho da novela ou pedido do Direct), vontade de mandar para alguém e cenas; abaixo de
     7 em qualquer item, o roteiro é reescrito com as notas.
5. **Publica no horário**. Se o computador ficou desligado e passou mais de 10 horas do horário,
   o post é pulado e a agenda segue.
6. **Aprende com os números**: 2 dias depois de cada post (e de novo perto do 7º dia) puxa
   visualizações, alcance, envios, salvos e interações. O planejamento seguinte dá mais espaço
   aos pilares que performam (até 1,8x, sem matar nenhum) e mostra para a IA os ganchos que mais
   e menos funcionaram. Envios e salvos pesam mais que visualização.

No painel: agenda com prévias, checklist do que falta, avisos, **Pausar conteúdo**, e em cada post
**Publicar agora**, **Refazer**, **Pular** e **Tentar de novo**.

## Ajustes

**Reels desligados por enquanto**: `reelDays` está vazio (`[]`) no config, então só saem os
carrosséis. Os Reels que já estavam na agenda são pulados. Para ligar de novo, ponha os dias de
volta (ex.: `[0, 1, 2, 3, 4, 5, 6]` para todo dia).

Tudo em `config/conteudo.json`: dias e horários, pilares, voz, público, chamada para ação,
regras, palavras proibidas (`forbiddenTerms`), assinatura das frases (`quoteSignature`), selo do
último slide (`brand.ctaBadge`), fatos permitidos, cores, estilo das imagens, vídeos por dia, `autoPublish` (com `false`
os posts ficam prontos esperando você clicar em Publicar agora).

## Para quem mexe no código

```
src/content/schedule.ts   horários da semana e rodízio de pilares
src/content/ai.ts         pauta, carrossel e Reel com a OpenAI, e as regras de texto
src/content/posts.ts      cada etapa (planejar, escrever, Gemini, desenhar, publicar)
src/content/planner.ts    a cada 30 s decide qual etapa roda
src/content/learning.ts   números dos posts e o que o planejamento aprende com eles
src/content/render.ts     slides e cartões em HTML desenhados por um Chrome invisível
src/content/video.ts      monta o Reel narrado com ffmpeg
src/integrations/openai/speech.ts   voz do narrador
src/integrations/gemini   Gemini no Chrome do operador (porta 9236)
src/integrations/instagram/publish.ts   publicação pela API da Meta
src/panel/server.ts       painel (calendário, novo com fotos) e rota pública assinada dos arquivos
```

`pnpm check` roda o typecheck e os testes (Gemini, OpenAI e Meta simulados, Chrome e ffmpeg de
verdade).
