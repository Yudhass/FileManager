@echo off
chcp 65001 >nul
title Build EXE - Fast File Manager
cd /d "%~dp0"

echo.
echo  ==================================================
echo   Build EXE - Fast File Manager (Desktop Installer)
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

for %%I in (main.js preload.js server.js transfer-worker.js public\index.html package.json) do (
  if not exist "%%I" (
    echo  [ERROR] File %%I tidak ditemukan.
    echo  Jalankan BAT ini dari folder aplikasi.
    echo.
    pause
    exit /b 1
  )
)

if not exist "node_modules" (
  echo  [1/3] Install dependensi (pertama kali, butuh internet)...
  call npm.cmd install
  echo.
) else (
  echo  [1/3] Dependensi sudah ada, lewati install.
)

if not exist "node_modules\electron-builder" (
  echo  [2/3] Install electron-builder...
  call npm.cmd install --save-dev electron-builder
  echo.
) else (
  echo  [2/3] electron-builder sudah ada.
)

echo  [3/3] Membangun EXE (bisa beberapa menit, jangan tutup)...
echo.
call npm.cmd run dist
echo.

if exist "dist" (
  echo  ==================================================
  echo   SELESAI! File hasil build ada di folder dist\
  echo  ==================================================
  dir /b dist\*.exe
  echo.
  echo  - Installer (Setup): install sekali, muncul di Start Menu/Desktop
  echo  - Portable : langsung double-klik tanpa install
  echo.
  start "" "dist"
) else (
  echo  [ERROR] Build gagal, folder dist\ tidak terbentuk.
  echo  Lihat pesan error di atas.
)

echo.
pause
