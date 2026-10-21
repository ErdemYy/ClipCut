# ClipCut Tek Tıkla Başlatıcı
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "       ClipCut Video AI Studio          " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Magenta

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1. Backend başlat
Write-Host "[1/2] Backend (FastAPI) baslatiliyor (Port 8000)..." -ForegroundColor Yellow
Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-Command", "cd '$rootDir\backend'; .\.venv\Scripts\uvicorn.exe app.main:app --host 127.0.0.1 --port 8000 --reload"

# 2. Frontend başlat
Write-Host "[2/2] Frontend (Next.js) baslatiliyor (Port 3000)..." -ForegroundColor Yellow
Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-Command", "cd '$rootDir\frontend'; npm.cmd run dev"

Start-Sleep -Seconds 3
Write-Host "`nClipCut hazir!" -ForegroundColor Green
Write-Host "Tarayicinizda acin: http://localhost:3000" -ForegroundColor Cyan
Write-Host "Backend API:       http://localhost:8000/docs" -ForegroundColor Cyan
