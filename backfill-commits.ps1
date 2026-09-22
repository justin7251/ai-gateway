# backfill-commits.ps1 - split the current project tree into one week of
# backdated git commits, one per day, starting 16/09 by default.

param(
  [string]$StartDate = "2026-09-16",
  [switch]$DryRun
)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "error: git not found - install Git for Windows first" -ForegroundColor Red
  exit 1
}

 $Plan = @(
  "0|09:12|chore: scaffold gateway (package.json, vercel.json, env template, gitignore)|package.json package-lock.json vercel.json .gitignore .env.example"
  "1|11:37|feat(lib): shared HTTP helpers, timing-safe auth, OpenAI-style normalization|lib/http.js lib/auth.js lib/normalize.js"
  "2|14:48|feat(lib): provider adapters + priority router with free-tier fallback|lib/providers lib/router.js"
  "3|16:22|feat(api): POST /api/v1/chat + Redis/SQLite rate limiting|api/v1/chat.js lib/rateLimiter.js"
  "4|10:05|feat(store): SQLite storage (libSQL) + usage/models endpoints + chat alias|lib/store.js api/v1/usage.js api/v1/models.js api/v1/chat/completions.js"
  "5|15:53|feat(streaming): SSE streaming + tool-calling passthrough|lib/streaming.js"
  "6|18:31|feat(ui): built-in chat UI, smoke tests, README, backfill script|public test README.md backfill-commits.ps1"
)

if (-not $DryRun) {
  if (-not (Test-Path .git)) { git init -q }
  if (-not (git config user.name 2>$null))  { git config --local user.name  "Personal AI Gateway" }
  if (-not (git config user.email 2>$null)) { git config --local user.email "gateway@example.com" }
}

foreach ($entry in $Plan) {
  $off, $tm, $msg, $files = $entry -split '\|', 4
  $d = ([datetime]::ParseExact($StartDate, "yyyy-MM-dd", $null)).AddDays([int]$off).ToString("yyyy-MM-dd")
  $stamp = "${d}T${tm}:00"

  if ($DryRun) {
    Write-Host "[dry-run] $d $tm  $msg"
    continue
  }

  $staged = $false
  foreach ($f in $files -split ' ') {
    if (-not $f) { continue }
    if (Test-Path $f) {
      git add -- $f
      if ($LASTEXITCODE -ne 0) { exit 1 }
      $staged = $true
    }
  }

  git diff --cached --quiet 2>$null
  if (-not $staged -or $LASTEXITCODE -eq 0) {
    Write-Host "skip   $d  (nothing staged): $msg"
    continue
  }

  $env:GIT_AUTHOR_DATE = $stamp
  $env:GIT_COMMITTER_DATE = $stamp
  git commit -q -m $msg
  if ($LASTEXITCODE -ne 0) { exit 1 }
  Write-Host "commit $d $tm  $msg"
}

Remove-Item Env:GIT_AUTHOR_DATE   -ErrorAction SilentlyContinue
Remove-Item Env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue

if (-not $DryRun) {
  Write-Host ""
  Write-Host "Resulting history (oldest first):"
  git log --reverse --format='%ad  %s' --date=format:'%d/%m %H:%M'
}
