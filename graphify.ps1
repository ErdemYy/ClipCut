param([switch]$Force)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Get-Command graphify -ErrorAction SilentlyContinue)) {
        throw 'Graphify bulunamadı. Önce uv tool install graphifyy çalıştırın.'
    }
    if (Test-Path 'graphify-out/graph.json') {
        $updateArgs = @('update', '.')
        if ($Force) { $updateArgs += '--force' }
        & graphify @updateArgs
    } else {
        # Bootstrap is local AST only: no API keys, providers or paid calls.
        & graphify extract . --code-only
    }
    if ($LASTEXITCODE -ne 0) { throw 'Graphify güncellemesi başarısız.' }
    & graphify export html
    if ($LASTEXITCODE -ne 0) { throw 'Graphify HTML çıktısı oluşturulamadı.' }
} finally {
    Pop-Location
}
