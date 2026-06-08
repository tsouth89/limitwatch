# Per-account Claude Code burn logger for LimitWatch.
# Appends a timestamped measured-burn point per account to data/burn-log.json so that when you
# later read an in-app usage %, the matching floor already exists. Reads local session transcripts
# only (no network). Run by Task Scheduler daily, or hourly for a finer weekly curve.
#
# Register (run once, in an elevated-or-normal PowerShell):
#   $a = New-ScheduledTaskAction -Execute "pwsh" -Argument "-NoProfile -File `"$PWD\scripts\burn-log.ps1`""
#   $t = New-ScheduledTaskTrigger -Daily -At 9am          # or -Once ... -RepetitionInterval (New-TimeSpan -Hours 1)
#   Register-ScheduledTask -TaskName "LimitWatch burn-log" -Action $a -Trigger $t -Description "Log Claude Code burn per account"

$ErrorActionPreference = "Stop"
$repo = "c:\projects\personal\ai-limit-tracker"
$env:Path += ";C:\Program Files\nodejs;C:\Program Files\GitHub CLI"

Set-Location $repo
git pull -q --rebase origin main

node "$repo\scripts\burn-log.mjs"
if ($LASTEXITCODE -ne 0) { Write-Error "burn-log.mjs failed ($LASTEXITCODE)"; exit 1 }

git -c user.name="bts-cssi" -c user.email="tsouth2@gmail.com" add data/burn-log.json
$pending = git status --porcelain data/burn-log.json
if ($pending) {
  git -c user.name="bts-cssi" -c user.email="tsouth2@gmail.com" commit -q -m "data: burn-log point [skip ci]"
  git push -q origin main
  Write-Host "[burn-log] point committed + pushed"
} else {
  Write-Host "[burn-log] no change"
}
