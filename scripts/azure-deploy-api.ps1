# Deploys (or updates) the API container app on Azure Container Apps, reading settings from the repo's .env.
# Secrets are read from .env and passed straight to Azure; nothing is printed.
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\azure-deploy-api.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\azure-deploy-api.ps1 -Tag v3 -CorsOrigin https://<web-address>
param(
  [string]$Tag = 'v2',
  [string]$ResourceGroup = 'cx-rg',
  [string]$Environment = 'cx-env',
  [string]$Registry = 'cxrohit17acr',
  [string]$AppName = 'cx-api',
  [string]$CorsOrigin = 'http://localhost:5173'
)
# Windows PowerShell 5.1 turns any text a native command writes to stderr (the az CLI prints harmless warnings there)
# into a terminating error under 'Stop'. So errors are detected from exit codes instead.
$ErrorActionPreference = 'Continue'
function Assert-Ok([string]$what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE). See the message above." } }

function Read-DotEnv([string]$path) {
  $map = @{}
  foreach ($line in Get-Content -LiteralPath $path) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $key = $t.Substring(0, $i).Trim()
    $val = $t.Substring($i + 1).Trim()
    if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
      $val = $val.Substring(1, $val.Length - 2)
    } else {
      $val = ($val -replace '\s+#.*$', '').Trim()   # strip an inline comment
    }
    if ($map.ContainsKey($key)) { Write-Host "Note: $key appears more than once in .env; using the first."; continue }
    $map[$key] = $val
  }
  return $map
}

$envFile = Join-Path (Get-Location) '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw ".env not found in $(Get-Location). Run this from the repo root." }
$e = Read-DotEnv $envFile
foreach ($k in 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY') {
  if (-not $e[$k]) { throw "$k is missing in .env" }
  # A real value is one token: pasted command text ("<...>", spaces, a trailing ^) means .env is damaged.
  if ($e[$k] -match '[\s<>^]') { throw "$k in .env does not look like a plain value (it contains spaces, < > or ^). Remove any pasted command text from .env." }
}
if ($e['SUPABASE_URL'] -notmatch '^https://[A-Za-z0-9.-]+$') { throw 'SUPABASE_URL in .env must look like https://<project>.supabase.co' }

Write-Host "Registry login..."
$user = az acr credential show -n $Registry --query username -o tsv
$pass = az acr credential show -n $Registry --query 'passwords[0].value' -o tsv
Assert-Ok 'Reading the registry credentials'
if (-not $user -or -not $pass) { throw 'Could not read the registry credentials.' }
$image = "$Registry.azurecr.io/cx-api:$Tag"

# Non-secret settings: fixed ones, plus these when present in .env
$vars = @('NODE_ENV=production', 'PORT=8080', 'LLM_MODE=openai', "CORS_ORIGINS=$CorsOrigin",
  "SUPABASE_URL=$($e['SUPABASE_URL'])", "SUPABASE_ANON_KEY=$($e['SUPABASE_ANON_KEY'])",
  'SUPABASE_SERVICE_ROLE_KEY=secretref:srole', 'OPENAI_API_KEY=secretref:openai')
$vars += "ORDER_GATE_ENABLED=$(if ($e['ORDER_GATE_ENABLED']) { $e['ORDER_GATE_ENABLED'] } else { 'true' })"
foreach ($k in 'ORDER_GATE_MAX_ATTEMPTS', 'OPENAI_CHAT_MODEL', 'OPENAI_VISION_MODEL', 'OPENAI_JUDGE_MODEL',
  'OPENAI_EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'RETRIEVAL_MIN_VECTOR_SIMILARITY', 'RETRIEVAL_RELATIVE_MARGIN',
  'RETRIEVAL_MIN_FUSED_SCORE', 'RETRIEVAL_TOP_K', 'RATE_LIMIT_AI_PER_AGENT_PER_MIN',
  'RATE_LIMIT_AI_PER_CONVERSATION_PER_MIN', 'REQUEST_TIMEOUT_MS') {
  if ($e[$k]) { $vars += "$k=$($e[$k])" }
}

$null = az containerapp show -n $AppName -g $ResourceGroup --query name -o tsv 2>&1
$exists = ($LASTEXITCODE -eq 0)

if (-not $exists) {
  Write-Host "Creating $AppName ($image)..."
  $args = @('containerapp', 'create', '-n', $AppName, '-g', $ResourceGroup, '--environment', $Environment,
    '--image', $image, '--registry-server', "$Registry.azurecr.io", '--registry-username', $user,
    '--registry-password', $pass, '--target-port', '8080', '--ingress', 'external',
    '--min-replicas', '1', '--max-replicas', '1',
    '--secrets', "openai=$($e['OPENAI_API_KEY'])", "srole=$($e['SUPABASE_SERVICE_ROLE_KEY'])",
    '--env-vars') + $vars
  & az @args | Out-Null
  Assert-Ok 'Creating the container app'
} else {
  Write-Host "Updating $AppName to $image..."
  & az containerapp registry set -n $AppName -g $ResourceGroup --server "$Registry.azurecr.io" --username $user --password $pass | Out-Null
  Assert-Ok 'Setting the registry login'
  & az containerapp secret set -n $AppName -g $ResourceGroup --secrets "openai=$($e['OPENAI_API_KEY'])" "srole=$($e['SUPABASE_SERVICE_ROLE_KEY'])" | Out-Null
  Assert-Ok 'Setting the secrets'
  $args = @('containerapp', 'update', '-n', $AppName, '-g', $ResourceGroup, '--image', $image, '--set-env-vars') + $vars
  & az @args | Out-Null
  Assert-Ok 'Updating the container app'
  # New secret VALUES (for example a rotated API key) only reach a running replica after a restart; an update that
  # changes nothing else does not start a new revision. Restart the active revision so they always take effect.
  $revision = az containerapp revision list -n $AppName -g $ResourceGroup --query "[?properties.active] | [0].name" -o tsv
  Assert-Ok 'Finding the active revision'
  if ($revision) {
    Write-Host "Restarting revision $revision so secrets take effect..."
    & az containerapp revision restart -n $AppName -g $ResourceGroup --revision $revision | Out-Null
    Assert-Ok 'Restarting the revision'
  }
}

$fqdn = az containerapp show -n $AppName -g $ResourceGroup --query properties.configuration.ingress.fqdn -o tsv
Assert-Ok 'Reading the API address'
Write-Host ''
Write-Host "Done. API address:  https://$fqdn"
Write-Host "Check:              https://$fqdn/health   and   https://$fqdn/ready"
