# Builds build\accessibility-mcp-demo.mcpb, the one-click install bundle.
# Why a staging folder: the bundle must hold only what the server needs at run time
# (compiled code, production dependencies, manifest), not tests, sources or dev tools.
# Why dist stays as separate files: analysisWorker.js is loaded by path at run time
# (by src/analyze.ts), so the code is shipped as-is and never merged into a single file.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$stage = Join-Path $root "build\bundle"
$output = Join-Path $root "build\accessibility-mcp-demo.mcpb"

npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed; not packing a stale bundle." }

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force (Join-Path $stage "dist") | Out-Null

# Compiled code only: tests and source maps would just add size.
# The Cloudflare Worker code (dist\worker.* and dist\web\, with their maps and tests)
# is also left out: the local bundle runs index.js over stdio and never loads it.
# Only top-level worker.* is matched, so analysisWorker.js (which the bundle needs) stays.
$distRoot = Join-Path $root "dist"
Get-ChildItem $distRoot -Recurse -File |
  ForEach-Object {
    $relative = $_.FullName.Substring($distRoot.Length).TrimStart("\")
    if ($_.Name -like "*.test.js" -or $_.Name -like "*.map" -or $_.Name -like "*.d.ts") { return }
    if ($relative -like "worker.*" -or $relative -like "web\*") { return }
    $target = Join-Path $stage "dist\$relative"
    New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
    Copy-Item $_.FullName $target
  }

foreach ($file in "package.json", "package-lock.json", "LICENSE", "README.md") { Copy-Item (Join-Path $root $file) $stage }
Copy-Item (Join-Path $root "bundle\manifest.json") $stage

# Production dependencies only, installed from the lock file so the bundle matches what was tested.
Push-Location $stage
try {
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "Installing production dependencies failed." }
} finally { Pop-Location }

npx mcpb validate (Join-Path $stage "manifest.json")
if ($LASTEXITCODE -ne 0) { throw "Manifest is not valid." }

if (Test-Path $output) { Remove-Item -Force $output }
npx mcpb pack $stage $output
if ($LASTEXITCODE -ne 0) { throw "Packing failed." }
Write-Host "Bundle written to $output"
