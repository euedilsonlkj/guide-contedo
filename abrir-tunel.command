#!/bin/zsh
# Endereco publico temporario (Cloudflare) so para a porta do painel do conteudo (3200).
# Usa uma copia propria do cloudflared, para nao se confundir com o tunel da prospeccao.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v cloudflared >/dev/null; then
  if ! command -v brew >/dev/null; then echo "ERRO: instale o Homebrew (https://brew.sh) ou o cloudflared."; exit 1; fi
  echo "Instalando cloudflared..."; brew install cloudflared || exit 1
fi
mkdir -p data && cp "$(command -v cloudflared)" data/cloudflared-guide && chmod +x data/cloudflared-guide
rm -f tunel-url.txt
echo "Abrindo tunel. Deixe esta janela aberta enquanto o conteudo estiver rodando."
./data/cloudflared-guide tunnel --no-autoupdate --url http://127.0.0.1:3200 2>&1 | while IFS= read -r line; do
  echo "$line"
  url=$(echo "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com')
  if [ -n "$url" ] && [ ! -f tunel-url.txt ]; then
    echo "$url" > tunel-url.txt
    echo ""; echo "TUNEL DO CONTEUDO GUIDE: $url"; echo ""
  fi
done
