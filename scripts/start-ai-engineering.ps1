param(
  [switch]$ApplyDispatch
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "Project Liberty AI Engineering Control Plane" -ForegroundColor Cyan
Write-Host "Repository: $RepoRoot"

npm run ai:validate
npm run ai:sync
npm run repo:validate
npm run ai:status

if ($ApplyDispatch) {
  npm run ai:dispatch -- --apply
} else {
  npm run ai:dispatch
}

Write-Host ""
Write-Host "Open Claude Code Desktop on this folder and tell the orchestration lead to consume the claimed/ready queues." -ForegroundColor Green
