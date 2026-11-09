@echo off
setlocal
rem Endereco publico temporario (Cloudflare) so para a porta do painel do conteudo (3200):
rem a Meta baixa por ele os slides e os videos na hora de publicar.
rem Usa uma copia propria do cloudflared (cloudflared-guide.exe), para nao se confundir com o
rem tunel do sistema de prospeccao.
cd /d "%~dp0"
title Tunel do conteudo Guide

call :achar_cloudflared
if defined CF goto tem_cloudflared
echo O cloudflared nao esta instalado.
choice /c SN /m "Instalar agora pelo winget"
if errorlevel 2 goto sem_cloudflared
winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
call :achar_cloudflared
if not defined CF goto sem_cloudflared

:tem_cloudflared
if not exist "data" mkdir "data"
copy /y "%CF%" "data\cloudflared-guide.exe" >nul
if exist "tunel-url.txt" del /q "tunel-url.txt"
echo Abrindo tunel. Deixe esta janela aberta enquanto o conteudo estiver rodando.
set "CF_EXE=%~dp0data\cloudflared-guide.exe"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$achou = $false; & $env:CF_EXE tunnel --no-autoupdate --url http://127.0.0.1:3200 2>&1 | ForEach-Object { $linha = [string]$_; Write-Host $linha; if (-not $achou -and $linha -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $achou = $true; $url = $Matches[0]; Set-Content -Path 'tunel-url.txt' -Value $url -Encoding Ascii; Write-Host ''; Write-Host ('TUNEL DO CONTEUDO GUIDE: ' + $url) -ForegroundColor Green; Write-Host '' } }"
echo.
echo O tunel fechou.
pause
exit /b 0

:sem_cloudflared
echo ERRO: cloudflared nao encontrado. Instale com: winget install --id Cloudflare.cloudflared
pause
exit /b 1

:achar_cloudflared
set "CF="
for /f "delims=" %%p in ('where cloudflared 2^>nul') do if not defined CF set "CF=%%p"
if not defined CF if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CF if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe" set "CF=%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe"
exit /b 0
