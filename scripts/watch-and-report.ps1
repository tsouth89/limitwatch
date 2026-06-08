# Weekly local watcher for LimitWatch.
# Runs the FULL source watch (incl. the headed OpenAI fetch that needs a real desktop),
# commits the advanced baseline, and opens a GitHub issue if any official page changed.
# Designed to be run by Task Scheduler "only when the user is logged on" (headed Chrome
# needs an interactive session). Missed runs catch up on next login.

$ErrorActionPreference = "Stop"
$repo = "c:\projects\personal\ai-limit-tracker"
$env:Path += ";C:\Program Files\nodejs;C:\Program Files\GitHub CLI"

Set-Location $repo
Write-Host "[watch] $(Get-Date -Format s) starting full source watch"

# Pull first so we don't collide with any cloud/manual run that advanced the baseline.
git pull -q --rebase origin main

# Full run (no --http-only) so the headed OpenAI fetch executes. --ci writes the summary.
node "$repo\scripts\fetch.mjs" --ci
if ($LASTEXITCODE -ne 0) { Write-Error "fetch.mjs failed ($LASTEXITCODE)"; exit 1 }

$summary = Join-Path $repo "data\_watch-summary.md"
if (Test-Path $summary) {
  Write-Host "[watch] changes detected -> opening issue"
  $title = "Source watch: official page(s) changed ($(Get-Date -Format yyyy-MM-dd))"
  try { gh issue create --title $title --body-file $summary --label "source-watch" }
  catch { gh issue create --title $title --body-file $summary }
  Remove-Item $summary -Force
} else {
  Write-Host "[watch] no changes"
}

# Persist the advanced baseline so next run compares fresh.
git -c user.name="bts-cssi" -c user.email="tsouth2@gmail.com" add data/source-state.json
$pending = git status --porcelain data/source-state.json
if ($pending) {
  git -c user.name="bts-cssi" -c user.email="tsouth2@gmail.com" commit -q -m "chore: advance source-watch baseline [skip ci]"
  git push -q origin main
  Write-Host "[watch] baseline committed + pushed"
} else {
  Write-Host "[watch] baseline unchanged"
}
Write-Host "[watch] done"
