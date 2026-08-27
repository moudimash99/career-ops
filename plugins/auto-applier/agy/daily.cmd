@echo off
cd /d C:\Users\Moudimash99\Documents\GitHub\AirBusAutoApplier
if not exist output\agy mkdir output\agy
agy -p "Read agy\daily-report.md and carry out exactly what it says." ^
    --dangerously-skip-permissions ^
    --print-timeout 30m ^
    >> output\agy\daily.log 2>&1
