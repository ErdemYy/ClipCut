@echo off
title ClipCut Backend
echo [ClipCut] Python sanal ortami ve FastAPI sunucusu baslatiliyor...
cd /d "%~dp0backend"
if exist ".venv\Scripts\uvicorn.exe" (
    ".venv\Scripts\uvicorn.exe" app.main:app --host 127.0.0.1 --port 8000 --reload
) else (
    echo Hata: .venv bulunamadi!
    pause
)
