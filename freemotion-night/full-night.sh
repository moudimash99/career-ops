#!/usr/bin/env bash
# freemotion-night/full-night.sh — a "full night run" (the user's words, 2026-10-10): one scan, then a
# round of applications every 5 hours until the morning.
#
#   bash freemotion-night/full-night.sh
#
# One scan at the start (scan.mjs). Then rounds: the pool again (make-pool.mjs --top 50), the sheets
# (make-jobs.mjs), run.sh over them, usage.mjs. A round starts 5 hours after the one before started, or
# at once when that one took longer. Rounds start as long as it is before 09:00; the first 5-hour mark
# at or after 09:00 still starts one last round, which runs to its end.
#
# Drivers, in order: agy, agy-sonnet, codex, copilot, the second Claude account (sonnet1), then this
# shell's own Claude account (sonnet) with no cap: it is used until it reports its limit, so the session
# that started the night may be out of allowance by the morning. Everything printed is also kept in
# tmp/fm/night/full-night.log.
#
# ROUND_JOBS=50, EVERY_HOURS=5, END_AT=09:00, DRIVER_ORDER="..." change the defaults; NO_SCAN=1 skips the scan;
# MAX_ROUNDS=N ends the night after N rounds (burn.mjs starts one round at a time).
# touch tmp/fm/night/stop-night: no further round starts (the round in hand finishes). With
# tmp/fm/night/stop as well, that round stops before its next job (run.sh).
# Only the first round asks APEC for routes: a second batch the same day meets its CAPTCHA (issue #25).
cd "$(dirname "$0")/.."
mkdir -p tmp/fm/night
exec > >(tee -a tmp/fm/night/full-night.log) 2>&1
ROUND_JOBS=${ROUND_JOBS:-50}
EVERY=$(( ${EVERY_HOURS:-5} * 3600 ))
export DRIVER_ORDER=${DRIVER_ORDER:-agy agy-sonnet codex copilot sonnet1 sonnet}
export SONNET_MAX_PER_WINDOW=${SONNET_MAX_PER_WINDOW:-100000}
end=$(date -d "${END_AT:-09:00}" +%s) || exit 1
[ "$end" -le "$(date +%s)" ] && end=$(( end + 86400 ))
rm -f tmp/fm/night/stop-night
echo "##### full night run, $(date '+%a %Y-%m-%d %H:%M'): $ROUND_JOBS jobs every $(( EVERY / 3600 )) h, last round at the first mark from $(date -d @$end '+%a %H:%M'); drivers: $DRIVER_ORDER"
[ -z "$NO_SCAN" ] && { node scan.mjs || echo "note: the scan failed; the rounds use the pool as it is"; }

round=0
while :; do
  round=$(( round + 1 )); t0=$(date +%s); last=
  [ "$t0" -ge "$end" ] && last=1
  [ -n "$MAX_ROUNDS" ] && [ "$round" -ge "$MAX_ROUNDS" ] && last=1
  echo; echo "===== round $round, $(date '+%a %H:%M')${last:+ (the last one)}"
  apec=; [ $round -gt 1 ] && apec=--no-apec
  if node freemotion-night/make-pool.mjs --top "$ROUND_JOBS" $apec; then
    count=$(node -e "console.log(JSON.parse(require('fs').readFileSync('tmp/fm/night/list.json','utf8')).length)")
    if [ "${count:-0}" -gt 0 ]; then
      top=$(ls tmp/fm/night | sed -nE 's/^job-([0-9]+)\.md$/\1/p' | awk '$1 < 9000' | sort -n | tail -1)
      first=$(( ${top:-0} + 1 ))
      node freemotion-night/make-jobs.mjs tmp/fm/night/list.json $first \
        && bash freemotion-night/run.sh $(seq $first $(( first + count - 1 )))
      node freemotion-night/usage.mjs
    else
      echo "note: the pool is empty; nothing to apply to this round"
    fi
  else
    echo "note: make-pool.mjs failed; no jobs this round"
  fi
  [ -n "$last" ] && break
  next=$(( t0 + EVERY ))
  [ "$next" -gt "$(date +%s)" ] && [ ! -f tmp/fm/night/stop-night ] && echo "note: round $round done at $(date '+%H:%M'); the next one starts at $(date -d @$next '+%H:%M')"
  while [ "$(date +%s)" -lt "$next" ] && [ ! -f tmp/fm/night/stop-night ]; do sleep 60; done
  if [ -f tmp/fm/night/stop-night ]; then rm -f tmp/fm/night/stop-night; echo "note: stop-night file found; no further round"; break; fi
done
echo "FULL NIGHT DONE, $(date '+%a %H:%M'): $round round(s)"
