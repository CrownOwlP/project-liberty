<#
  PL-AI-0002 — GitHub bridge for cross-agent review.

  Establishes https://github.com/CrownOwlP/project-liberty.git as origin for the
  authoritative local repository at D:\project-liberty and verifies the bridge
  rather than assuming it.

  Safety properties:
    - never runs reset, rebase, force-push, or any history-rewriting command
    - refuses to proceed if an origin already exists pointing somewhere else
    - refuses to proceed if the remote branch already has commits
    - verifies local HEAD SHA == remote main SHA after pushing
    - exits non-zero on any verification failure so no gate can be recorded

  Usage:  powershell -ExecutionPolicy Bypass -File scripts\establish-github-bridge.ps1
#>

$ErrorActionPreference = "Stop"
Set-Location -Path (Split-Path -Parent $PSScriptRoot)

$RemoteUrl = "https://github.com/CrownOwlP/project-liberty.git"
$ok = $true
function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "  FAIL: $msg" -ForegroundColor Red; $script:ok = $false }
function Pass($msg) { Write-Host "  OK:   $msg" -ForegroundColor Green }

Step 1 "Working tree and current branch"
git rev-parse --is-inside-work-tree | Out-Null
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$dirty  = (git status --porcelain)
Write-Host "  branch: $branch"
if ([string]::IsNullOrWhiteSpace($dirty)) {
  Pass "working tree clean"
} else {
  Write-Host "  uncommitted changes present:" -ForegroundColor Yellow
  git status --short
  Write-Host "  -> commit these before pushing so the bridge reflects real state." -ForegroundColor Yellow
}

Step 2 "Confirm the GitHub repository is empty"
$remoteRefs = (git ls-remote --heads $RemoteUrl 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  Fail "cannot reach $RemoteUrl -- check credentials/network:`n$remoteRefs"
} elseif ([string]::IsNullOrWhiteSpace($remoteRefs)) {
  Pass "remote has no branches (empty repository)"
} else {
  Fail "remote already has branches; refusing to proceed without an explicit decision:`n$remoteRefs"
}

Step 3 "Ensure origin exists and points at the intended repository"
$origin = (git remote get-url origin 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($origin)) {
  git remote add origin $RemoteUrl
  Pass "origin added -> $RemoteUrl"
} elseif ($origin.Trim() -eq $RemoteUrl) {
  Pass "origin already correct -> $RemoteUrl"
} else {
  Fail "origin already set to $($origin.Trim()); not overwriting it"
}

Step 4 "Preserve existing history (no reset / no recreate)"
$commitCount = (git rev-list --count HEAD).Trim()
Pass "$commitCount commit(s) will be preserved and pushed"

Step 5 "Ensure the primary local branch is main"
if ($branch -eq "main") {
  Pass "already on main"
} elseif ($ok) {
  git branch -M main
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  Pass "renamed current branch to main (history preserved)"
}

if (-not $ok) {
  Write-Host "`nAborting before push: preconditions failed." -ForegroundColor Red
  exit 1
}

Step 6 "Push complete repository and history"
git push -u origin main
if ($LASTEXITCODE -ne 0) { Fail "git push failed"; exit 1 }
Pass "pushed"

Step 7 "Verify remote main SHA matches local HEAD"
$localSha  = (git rev-parse HEAD).Trim()
$remoteSha = ((git ls-remote origin refs/heads/main) -split "\s+")[0]
Write-Host "  local  HEAD : $localSha"
Write-Host "  remote main : $remoteSha"
if ($localSha -eq $remoteSha -and -not [string]::IsNullOrWhiteSpace($remoteSha)) {
  Pass "bridge verified: remote main == local HEAD"
} else {
  Fail "SHA mismatch -- bridge NOT verified; do not record the gate"
  exit 1
}

Step 8 "Control-plane validation and sync"
npm run ai:validate
if ($LASTEXITCODE -ne 0) { Fail "ai:validate failed"; exit 1 }
npm run ai:sync
if ($LASTEXITCODE -ne 0) { Fail "ai:sync failed"; exit 1 }
npm run ai:status

Write-Host "`n=== BRIDGE ESTABLISHED ===" -ForegroundColor Green
Write-Host "local HEAD SHA : $localSha"
Write-Host "remote main SHA: $remoteSha"
Write-Host "branch         : $branch"
Write-Host "origin         : $RemoteUrl"
Write-Host "`nPL-AI-0002 is NOT complete yet. It still requires:" -ForegroundColor Yellow
Write-Host "  - architecture-review and security-review gates recorded with real evidence"
Write-Host "  - an APPROVED independent review record from its reviewAgent"
Write-Host "  - see the reviewer-deadlock note in coordination/CLAUDE_TO_GPT.md"
