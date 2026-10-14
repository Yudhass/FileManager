@echo off
chcp 65001 >nul
title Dual-Pane Fast File Manager (Desktop)
cd /d "%~dp0"

echo.
echo  ==================================================
echo   Dual-Pane Fast File Manager - DESKTOP
echo  ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js tidak ditemukan!
  echo  Download dan install dulu dari: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for %%I in (main.js preload.js server.js transfer-worker.js public\index.html) do (
  if not exist "%%I" (
    echo  [ERROR] File %%I tidak ditemukan di folder aplikasi\
    echo.
    pause
    exit /b 1
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo  Runtime desktop belum ada, menginstall sekali saja...
  echo  (butuh internet, tunggu sampai selesai)
  echo.
  call npm.cmd install
  echo.
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo  [ERROR] Runtime Electron gagal terinstall.
  echo  Coba manual: npm install
  echo.
  pause
  exit /b 1
)

set PORT=4821
echo  Membuka aplikasi desktop...
start "FastFileManager" "node_modules\electron\dist\electron.exe" .
echo  Jendela aplikasi akan muncul. File BAT ini boleh ditutup.
timeout /t 3 >nul
exit
