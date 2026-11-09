@echo off
setlocal
rem Liga o conteudo do Instagram: instala se precisar, abre o Chrome do Gemini, o tunel e o sistema.
rem Roda junto com o sistema de prospeccao, sem um depender do outro.
cd /d "%~dp0"
title LIGAR CONTEUDO GUIDE
where node >nul 2>nul
if errorlevel 1 goto sem_node

echo == 1/4 Verificando instalacao ==
if not exist ".env" goto instalar
if not exist "node_modules\.modules.yaml" goto instalar
node -e "const fs=require('fs');process.exit(fs.statSync('pnpm-lock.yaml').mtimeMs>fs.statSync('node_modules/.modules.yaml').mtimeMs?1:0)"
if errorlevel 1 goto instalar
echo Tudo instalado.
goto chrome
:instalar
call "%~dp0instalar.bat" /auto
if errorlevel 1 goto erro_instalar

:chrome
echo == 2/4 Chrome do Gemini ==
rem Quantas contas do Gemini: GEMINI_ACCOUNTS no .env (sem a linha = 2).
set "CONTAS=2"
for /f %%c in ('node scripts\contas-gemini.mjs') do set "CONTAS=%%c"
echo Contas do Gemini: %CONTAS% (GEMINI_ACCOUNTS no .env)
for /l %%n in (1,1,%CONTAS%) do call :chrome_conta %%n
goto tunel

:chrome_conta
set /a PORTA_GEMINI=9235+%1
curl.exe -s -m 2 http://127.0.0.1:%PORTA_GEMINI%/json/version >nul 2>nul
if not errorlevel 1 (
  echo Chrome do Gemini da conta %1 ja estava aberto.
  exit /b 0
)
call "%~dp0abrir-chrome-gemini.bat" %1
ping -n 4 127.0.0.1 >nul
exit /b 0

:tunel
echo == 3/4 Tunel do conteudo Guide ==
tasklist /fi "imagename eq cloudflared-guide.exe" 2>nul | find /i "cloudflared-guide.exe" >nul
if not errorlevel 1 goto tunel_aberto
start "Tunel do conteudo Guide" "%~dp0abrir-tunel.bat"
set /a ESPERA=0
:esperar_tunel
if exist "tunel-url.txt" goto tunel_aberto
if %ESPERA% geq 30 goto tunel_aberto
ping -n 2 127.0.0.1 >nul
set /a ESPERA+=1
goto esperar_tunel
:tunel_aberto
if exist "tunel-url.txt" (set /p URL_TUNEL=<"tunel-url.txt") else (set "URL_TUNEL=ainda abrindo, veja a janela do tunel")
echo Tunel: %URL_TUNEL%

echo == 4/4 Ligando o conteudo ==
echo Painel: http://127.0.0.1:3200 (a senha esta no .env, em PANEL_PASSWORD)
echo Deixe esta janela e a do tunel abertas. Para desligar, aperte Ctrl + C aqui.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 90; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:3200/' | Out-Null; break } catch { if ($_.Exception.Response) { break }; Start-Sleep -Seconds 2 } }; Start-Process 'http://127.0.0.1:3200'"
call npx -y pnpm@10.34.7 start
echo.
echo O conteudo parou. Para ligar de novo, abra o LIGAR-CONTEUDO.bat.
pause
exit /b 0

:sem_node
echo ERRO: Node nao encontrado. Instale o Node 24: https://nodejs.org/dist/latest-v24.x/
pause
exit /b 1

:erro_instalar
echo ERRO na instalacao. Tire um print desta janela e mande para o suporte.
pause
exit /b 1
