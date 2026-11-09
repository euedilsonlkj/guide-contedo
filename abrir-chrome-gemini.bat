@echo off
setlocal
rem Chrome so do Gemini (conteudo do Instagram). Cada conta Google tem o seu:
rem   abrir-chrome-gemini.bat      conta 1 (porta 9236, pasta .chrome-profile-gemini)
rem   abrir-chrome-gemini.bat 2    conta 2 (porta 9237, pasta .chrome-profile-gemini-2)
rem Na primeira vez, entre na conta Google daquela janela.
cd /d "%~dp0"
set "CONTA=%~1"
if "%CONTA%"=="" set "CONTA=1"
set /a PORTA=9235+%CONTA%
set "PERFIL=%~dp0.chrome-profile-gemini"
if not "%CONTA%"=="1" set "PERFIL=%~dp0.chrome-profile-gemini-%CONTA%"
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome Beta\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome Beta\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome Beta\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome Beta\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME goto sem_chrome

start "" "%CHROME%" --remote-debugging-port=%PORTA% --remote-debugging-address=127.0.0.1 --user-data-dir="%PERFIL%" --no-first-run --no-default-browser-check --window-name="Agente Gemini Guide conta %CONTA%" --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling "https://gemini.google.com/app"
echo Chrome do Gemini da conta %CONTA% aberto (porta %PORTA%). Na primeira vez, entre na conta Google nessa janela.
exit /b 0

:sem_chrome
echo ERRO: Google Chrome nao encontrado.
echo Instale o Google Chrome: https://www.google.com/chrome/
pause
exit /b 1
