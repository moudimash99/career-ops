# Set yourself up — a task for agy

Mohammad wants this repo's **daily job report** produced by you, on this
laptop, instead of by a Claude cloud routine. Do the setup below yourself; do
not hand any of it back as instructions for him to run.

## Why you and not the cloud

A Claude cloud routine was built for this first and is now **disabled**. Its
sandbox has no outbound network: every job board, and `www.google.com` with
them, answered `403 Forbidden` on CONNECT from its egress proxy, so it could
not fetch a single posting. The evidence is in `reports/2026-08-24.md`.

You run locally, so you have what it could not have: real network, the `.venv`,
the application record under `output\`, the run logs, and the career-ops CV.

## 1. Check the prerequisites

Confirm each of these before you build anything, and report any that fail
rather than working around it:

- `C:\Users\Moudimash99\Documents\GitHub\AirBusAutoApplier\.venv\Scripts\python.exe` exists.
- `.venv\Scripts\python.exe -c "import selenium, bs4"` succeeds.
- `C:\Users\Moudimash99\Documents\Coding\career-ops\cv.md` exists — Step 3 of
  the daily job scores against it.
- `git ls-remote origin master` succeeds without prompting for credentials. The
  daily job pushes the report, and a scheduled task cannot answer a password
  prompt.
- `agy --version` (or `agy models`) works from a plain `cmd.exe`, not just from
  your current shell.

## 2. Write the wrapper

Create `agy\daily.cmd` in this repo:

    @echo off
    cd /d C:\Users\Moudimash99\Documents\GitHub\AirBusAutoApplier
    if not exist output\agy mkdir output\agy
    agy -p "Read agy\daily-report.md and carry out exactly what it says." ^
        --dangerously-skip-permissions ^
        --print-timeout 30m ^
        >> output\agy\daily.log 2>&1

Two notes on that command, both deliberate:

- The prompt is one line and the real instructions live in
  `agy\daily-report.md`, so the job is version-controlled and can be edited
  without touching the scheduled task.
- `--dangerously-skip-permissions` is required for an unattended run — there is
  nobody at the keyboard to approve a tool call. It is why
  `agy\daily-report.md` states the limits (no browser, no submitting, nothing
  committed to master outside `reports\`) as rules rather than as preferences.
  If you can achieve unattended operation with a narrower flag, prefer it and
  say what you used.

## 3. Register the scheduled task

Use PowerShell, not `schtasks`. This laptop is not always awake at 07:00 and
`-StartWhenAvailable` is what makes a missed run fire on the next wake, which
plain `schtasks` will not do:

    $action  = New-ScheduledTaskAction -Execute 'cmd.exe' `
                 -Argument '/c "C:\Users\Moudimash99\Documents\GitHub\AirBusAutoApplier\agy\daily.cmd"'
    $trigger = New-ScheduledTaskTrigger -Daily -At 07:00
    $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable `
                 -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
                 -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName 'AirBusAutoApplier daily report' `
        -Action $action -Trigger $trigger -Settings $set `
        -Description 'Scores open postings against the CV and writes reports\YYYY-MM-DD.md'

07:00 local is the intended time; keep it unless Mohammad says otherwise.

## 4. Prove it works

Do not declare this done on a task that has never run.

- `Start-ScheduledTask -TaskName 'AirBusAutoApplier daily report'`, then watch
  `output\agy\daily.log`.
- Confirm a `reports\YYYY-MM-DD.md` was written **and** pushed
  (`git log origin/master -1 --stat`).
- Confirm no browser window opened and nothing outside `reports\` was
  committed.
- `Get-ScheduledTaskInfo -TaskName 'AirBusAutoApplier daily report'` should
  show `LastTaskResult` 0 and a sane `NextRunTime`.

If the first run fails, fix the cause and run it again. A registered task that
has only ever failed is not a working setup.

## 5. Report back

Tell Mohammad, in a few lines: that the task is registered and when it next
fires, what the first real run produced, and anything you had to change in
`agy\daily-report.md` to make it work. If a prerequisite in Step 1 failed and
you could not fix it, lead with that.

Commit `agy\daily.cmd` and any edit you made to `agy\daily-report.md` on a
branch and tell him the branch name. Do not push to master — the daily job's
report is the only thing that goes there.
