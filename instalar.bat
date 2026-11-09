@echo off
setlocal
rem Instala tudo: confere o Node, cria o .env (com senha do painel) e instala as dependencias.
rem O LIGAR-CONTEUDO.bat chama este arquivo com /auto (sem pausa no final).
cd /d "%~dp0"
set "AUTO="
if /i "%~1"=="/auto" set "AUTO=1"

echo == Verificando Node ==
where node >nul 2>nul
if errorlevel 1 goto sem_node
node -e "process.exit(parseInt(process.versions.node, 10) >= 24 ? 0 : 1)"
if errorlevel 1 goto node_velho

echo == Preparando o .env ==
node scripts\preparar-env.mjs
if errorlevel 10 goto abrir_env
if errorlevel 1 goto erro
goto instalar
:abrir_env
echo O Bloco de Notas vai abrir o .env. Coloque a OPENAI_API_KEY e o token do Instagram, salve e feche.
start "" /wait notepad ".env"

:instalar
echo == Instalando dependencias ==
call npx -y pnpm@10.34.7 install --frozen-lockfile
if errorlevel 1 goto erro
echo.
echo INSTALACAO CONCLUIDA
if not defined AUTO pause
exit /b 0

:sem_node
echo ERRO: Node nao encontrado.
goto pedir_node
:node_velho
for /f "delims=" %%v in ('node -v') do echo ERRO: o Node instalado e o %%v e o sistema precisa do Node 24.
:pedir_node
echo Baixe o instalador .msi do Node 24 em https://nodejs.org/dist/latest-v24.x/
echo Depois de instalar, feche esta janela e abra de novo.
pause
exit /b 1

:erro
echo.
echo ERRO na instalacao. Tire um print desta janela e mande para o suporte.
if not defined AUTO pause
exit /b 1
