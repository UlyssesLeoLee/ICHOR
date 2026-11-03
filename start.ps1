# AI Test Studio v0.1 Portable mode. Requires Node.js >=22.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Please install Node.js >=22 (https://nodejs.org/) first.' -ForegroundColor Red
  exit 1
}
Write-Host 'AI Test Studio -- local runner at http://127.0.0.1:4577/fallback.html' -ForegroundColor Cyan
Start-Process 'http://127.0.0.1:4577/fallback.html'
node .\server\index.mjs
