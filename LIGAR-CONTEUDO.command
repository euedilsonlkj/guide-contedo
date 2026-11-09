#!/bin/zsh
# Liga o conteudo do Instagram: instala se precisar, abre o Chrome do Gemini, o tunel e o sistema.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
[ -d "$PWD/.node24/node_modules/node/bin" ] && export PATH="$PWD/.node24/node_modules/node/bin:$PATH"

echo "== 1/4 Verificando instalacao =="
if [ ! -f .env ] || [ ! -f node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  zsh ./instalar.command || { echo "ERRO na instalacao. Mande um print."; read; exit 1; }
  [ -d "$PWD/.node24/node_modules/node/bin" ] && export PATH="$PWD/.node24/node_modules/node/bin:$PATH"
else
  echo "Tudo instalado."
fi

echo "== 2/4 Chrome do Gemini =="
CONTAS=$(node scripts/contas-gemini.mjs 2>/dev/null)
echo "Contas do Gemini: ${CONTAS:-2} (GEMINI_ACCOUNTS no .env)"
for n in $(seq 1 "${CONTAS:-2}"); do
  if curl -s -m 2 "http://127.0.0.1:$((9235 + n))/json/version" >/dev/null; then
    echo "Chrome do Gemini da conta $n ja estava aberto."
  else
    zsh ./abrir-chrome-gemini.command "$n"
    sleep 3
  fi
done

echo "== 3/4 Tunel do conteudo Guide =="
if pgrep -f "cloudflared-guide tunnel" >/dev/null; then
  echo "Tunel ja estava aberto."
else
  open -a Terminal "$PWD/abrir-tunel.command"
  for i in {1..30}; do [ -f tunel-url.txt ] && break; sleep 1; done
fi
[ -f tunel-url.txt ] && echo "Tunel: $(cat tunel-url.txt)" || echo "Tunel ainda abrindo, veja a janela dele."

echo "== 4/4 Ligando o conteudo =="
echo "Painel: http://127.0.0.1:3200 (a senha esta no .env, em PANEL_PASSWORD)"
echo "Deixe esta janela e a do tunel abertas. Para desligar, aperte Ctrl + C aqui."
(for i in $(seq 1 90); do curl -s -o /dev/null -m 2 http://127.0.0.1:3200/ && break; sleep 2; done; open "http://127.0.0.1:3200") &
exec npx -y pnpm@10.34.7 start
