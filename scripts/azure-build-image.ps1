# Builds the API Docker image in Azure Container Registry from a clean copy of the repo.
# (A clean copy is needed because the Azure CLI cannot pack pnpm's very deep node_modules folders on Windows,
#  and so that .env and other secrets are never uploaded.)
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\azure-build-image.ps1 -Tag v3
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$Registry = 'cxrohit17acr',
  [string]$Staging = 'C:\cx-build'
)
$ErrorActionPreference = 'Continue'   # az prints harmless warnings on stderr; failures are caught via exit codes
$repo = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $repo 'Dockerfile'))) { throw 'Run this from the repo root (the folder with the Dockerfile).' }

Write-Host "Copying a clean build context to $Staging ..."
& robocopy $repo $Staging /E /NFL /NDL /NJH /NJS /NP /XD node_modules dist .git .claude .supabase playwright-report test-results /XF .env .env.local .env.development .env.production .env.test | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the files failed (robocopy exit code $LASTEXITCODE)." }

Write-Host "Building cx-api:$Tag in $Registry (takes ~2 minutes) ..."
Push-Location $Staging
try {
  & az acr build -r $Registry -t "cx-api:$Tag" .
  if ($LASTEXITCODE -ne 0) { throw "The image build failed (exit code $LASTEXITCODE). See the message above." }
} finally { Pop-Location }

Write-Host ''
Write-Host "Built $Registry.azurecr.io/cx-api:$Tag"
Write-Host "Next: powershell -ExecutionPolicy Bypass -File scripts\azure-deploy-api.ps1 -Tag $Tag"
