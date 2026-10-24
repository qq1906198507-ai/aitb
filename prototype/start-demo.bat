@echo off
setlocal
cd /d "%~dp0backend"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. Please install it from nodejs.org and run this file again.
    pause
    exit /b 1
)

if not exist node_modules (
    echo First run: installing dependencies...
    call npm install
    if errorlevel 1 (
        echo npm install failed. Check your network connection and run this file again.
        pause
        exit /b 1
    )
)

rem One local server hosts both the pages and the API. Close its window to stop it.
powershell -NoProfile -Command "try { if ((Invoke-RestMethod http://127.0.0.1:3000/health -TimeoutSec 2).service -eq 'netsave-engine') { exit 0 } } catch {}; exit 1"
if errorlevel 1 start "NetSave Backend" /min cmd /k node server.js
for /L %%i in (1,1,8) do (
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest http://127.0.0.1:3000/mobile-api.html -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
    if not errorlevel 1 goto ready
    ping -n 2 127.0.0.1 >nul
)
echo The local service did not start. Check the NetSave Backend window and port 3000.
pause
exit /b 1
:ready
start "" "http://127.0.0.1:3000/mobile-api.html"
endlocal
