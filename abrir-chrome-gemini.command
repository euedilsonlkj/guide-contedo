#!/bin/zsh
# Chrome so do Gemini (conteudo do Instagram). Cada conta Google tem o seu:
#   abrir-chrome-gemini.command      conta 1 (porta 9236, pasta .chrome-profile-gemini)
#   abrir-chrome-gemini.command 2    conta 2 (porta 9237, pasta .chrome-profile-gemini-2)
cd "$(dirname "$0")"
CONTA="${1:-1}"
PORTA=$((9235 + CONTA))
PERFIL="$PWD/.chrome-profile-gemini"
[ "$CONTA" != "1" ] && PERFIL="$PWD/.chrome-profile-gemini-$CONTA"
CHROME="/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"
[ -x "$CHROME" ] || CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" \
  --remote-debugging-port=$PORTA --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PERFIL" --no-first-run --no-default-browser-check --window-name="Agente Gemini Guide conta $CONTA" \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
  "https://gemini.google.com/app" >/dev/null 2>&1 &
echo "Chrome do Gemini da conta $CONTA aberto (porta $PORTA). Na primeira vez, entre na conta Google nessa janela."
