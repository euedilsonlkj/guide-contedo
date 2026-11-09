#!/bin/zsh
# Instala tudo: confere o Node, cria o .env (com senha do painel) e instala as dependencias.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
echo "== Verificando Node =="
if ! command -v node >/dev/null; then echo "ERRO: Node nao encontrado. Instale em https://nodejs.org (versao 24 LTS)."; exit 1; fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  echo "Node abaixo da 24: instalando Node 24 so para este projeto (.node24)"
  npm install --prefix "$PWD/.node24" node@24 >/dev/null || { echo "ERRO ao instalar Node 24"; exit 1; }
fi
[ -d "$PWD/.node24/node_modules/node/bin" ] && export PATH="$PWD/.node24/node_modules/node/bin:$PATH"
echo "Usando Node $(node -v)"
echo "== Preparando o .env =="
node scripts/preparar-env.mjs
if [ $? -eq 10 ]; then
  echo "Abra o arquivo .env desta pasta, coloque a OPENAI_API_KEY e o token do Instagram e salve."
  open -e .env
fi
echo "== Instalando dependencias =="
npx -y pnpm@10.34.7 install --frozen-lockfile || { echo "ERRO na instalacao"; exit 1; }
echo ""
echo "INSTALACAO CONCLUIDA"
