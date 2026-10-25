# Builds the web app against the deployed API and publishes it to Azure Static Web Apps, then tells the API to accept it.
# VITE_* values are read from .env (they are the public Supabase URL and anon key, never the service-role key).
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\azure-deploy-web.ps1 -ApiUrl https://cx-api.<...>.azurecontainerapps.io
param(
  [Parameter(Mandatory = $true)][string]$ApiUrl,
  [string]$ResourceGroup = 'cx-rg',
  [string]$Name = 'cx-web',
  [string]$Location = 'eastasia',
  [switch]$SkipCors
)
# Windows PowerShell 5.1 turns text a native command writes to stderr (az prints harmless warnings) into a
# terminating error under 'Stop'. Errors are detected from exit codes instead.
$ErrorActionPreference = 'Continue'
function Assert-Ok([string]$what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE). See the message above." } }

function Read-DotEnv([string]$path) {
  $map = @{}
  foreach ($line in Get-Content -LiteralPath $path) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $val = $t.Substring($i + 1).Trim()
    if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
      $val = $val.Substring(1, $val.Length - 2)
    } else {
      $val = ($val -replace '\s+#.*$', '').Trim()
    }
    $map[$t.Substring(0, $i).Trim()] = $val
  }
  return $map
}

$ApiUrl = $ApiUrl.TrimEnd('/')
$envFile = Join-Path (Get-Location) '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw ".env not found in $(Get-Location). Run this from the repo root." }
$e = Read-DotEnv $envFile
foreach ($k in 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY') {
  if (-not $e[$k]) { throw "$k is missing in .env" }
}

Write-Host "Checking the API at $ApiUrl/health ..."
try {
  $h = Invoke-WebRequest -Uri "$ApiUrl/health" -UseBasicParsing -TimeoutSec 30
  if ($h.StatusCode -ne 200) { throw "status $($h.StatusCode)" }
} catch {
  throw "The API is not answering at $ApiUrl/health ($($_.Exception.Message)). Fix the API first (az containerapp logs show -n cx-api -g $ResourceGroup --type console --tail 60)."
}

Write-Host 'Building the web app...'
$env:VITE_API_URL = $ApiUrl
$env:VITE_SUPABASE_URL = $e['VITE_SUPABASE_URL']
$env:VITE_SUPABASE_ANON_KEY = $e['VITE_SUPABASE_ANON_KEY']
& pnpm --filter '@cx/web' build
Assert-Ok 'Building the web app'

# One-time per subscription: Static Web Apps lives in the Microsoft.Web provider.
$state = az provider show -n Microsoft.Web --query registrationState -o tsv
if ($state -ne 'Registered') {
  Write-Host 'Enabling Static Web Apps for this subscription (one time, can take a minute or two)...'
  & az provider register --namespace Microsoft.Web --wait
  Assert-Ok 'Registering Microsoft.Web'
}

$null = az staticwebapp show -n $Name -g $ResourceGroup --query name -o tsv 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating the static web app $Name..."
  & az staticwebapp create -n $Name -g $ResourceGroup -l $Location --sku Free | Out-Null
  Assert-Ok 'Creating the static web app'
}
$token = az staticwebapp secrets list -n $Name -g $ResourceGroup --query properties.apiKey -o tsv
Assert-Ok 'Reading the deployment token'

Write-Host 'Uploading...'
& npx --yes '@azure/static-web-apps-cli' deploy apps/web/dist --deployment-token $token --env production
Assert-Ok 'Uploading the web app'

$hostName = az staticwebapp show -n $Name -g $ResourceGroup --query defaultHostname -o tsv
Assert-Ok 'Reading the web address'
$web = "https://$hostName"
Write-Host ''
Write-Host "Web address: $web"

if (-not $SkipCors) {
  Write-Host 'Letting the API accept requests from the web address...'
  & powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\azure-deploy-api.ps1" -CorsOrigin $web
  Assert-Ok 'Updating the API CORS setting'
}
Write-Host ''
Write-Host "Open $web and log in. In Supabase (Authentication > URL Configuration) set the Site URL to $web."
