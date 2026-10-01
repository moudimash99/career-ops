#!/usr/bin/env bash
# freemotion-night/run.sh <num>... — overnight queue, one job at a time.
# Hands each sheet tmp/fm/night/job-<num>.md (written by make-jobs.mjs) to a fresh agent session.
# Skips jobs that already have a final result in this run. Retries network failures.
# Prints one line per job: "job N (driver): outcome".
#
# Drivers, tried in this order for every job (the user's order, 2026-10-01):
#   agy          agy on its default model
#   agy-sonnet   agy on Claude Sonnet (agy's own Claude allowance, separate from the default model's)
#   codex        codex exec (the project's .codex/config.toml gives it the Playwright browser)
#   sonnet1      claude -p --model sonnet on the SECOND Claude subscription (CLAUDE1_DIR, default
#                ~/.claude-account1), which no watching session uses: no cap.
#   sonnet       claude -p --model sonnet on this shell's own Claude plan, which the session watching
#                the run also needs, so it is capped: at most SONNET_MAX_PER_WINDOW jobs (default 8) in
#                any 5 hours. One 5-hour window held ~18 Sonnet jobs on 2026-09-30, so 8 leaves a buffer.
# touch tmp/fm/night/stop: the run stops before its next job (the job in hand finishes).
# When a driver reports its limit, it is marked out until its reset (tmp/fm/night/out/<driver> holds
# the epoch) and the same job goes to the next one. When every driver is out, the run WAITS for the
# first reset (checking at least hourly) instead of stopping.
# DRIVER_ORDER="codex agy" bash freemotion-night/run.sh ...: another order, or fewer drivers.
# DRIVER=<one driver> (agy | agy-sonnet | codex | copilot | sonnet1 | sonnet): only that one; when it runs out
# the job in hand is left for a retry and the run stops. AGY_ONLY=1 is DRIVER=agy.
# CODEX_MODEL picks the model (default: the one in ~/.codex/config.toml), CODEX_EFFORT the
# reasoning effort (low | medium | high), e.g. CODEX_MODEL=gpt-6-sol CODEX_EFFORT=low.
# AGY_SONNET_MODEL is agy's Sonnet model name (default claude-sonnet-4-6).
# DRIVER=copilot: GitHub Copilot CLI (copilot -p), with the same Camoufox browser as Claude (.mcp.json).
# The model is the one set in Copilot itself (/model in an interactive `copilot`, saved in
# ~/.copilot/config.json; else auto): on this account the --model flag rejects every name
# (2026-09-30), so COPILOT_MODEL is passed only when set (e.g. auto). COPILOT_MAX_CREDITS caps one job.
cd "$(dirname "$0")/.."
ROOT=$(pwd -W 2>/dev/null || pwd)   # Windows-style path when available, for the agent prompt
RUN=$(cat tmp/fm/night/run-id 2>/dev/null) || { echo "no tmp/fm/night/run-id: run freemotion-night/make-jobs.mjs first"; exit 1; }
OUT=tmp/fm/night/out
mkdir -p tmp/fm/usage "$OUT"
ORDER=${DRIVER_ORDER:-agy agy-sonnet codex sonnet1 sonnet}
CLAUDE1_DIR=${CLAUDE1_DIR:-$(cd ~ && (pwd -W 2>/dev/null || pwd))/.claude-account1}
[ -n "$AGY_ONLY" ] && DRIVER=agy
[ -n "$DRIVER" ] && ORDER=$DRIVER
NDRIVERS=$(echo $ORDER | wc -w)
SONNET_MAX=${SONNET_MAX_PER_WINDOW:-8}
AGY_SONNET_MODEL=${AGY_SONNET_MODEL:-claude-sonnet-4-6}
prompt() { echo "Read the file $ROOT/tmp/fm/night/job-$1.md and carry out the task it describes, from start to finish, without stopping to ask."; }
RUN_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)  # the end-of-run letter sample covers this run only
url_of() { grep -m1 -oE '^   https?://\S+' "tmp/fm/night/job-$1.md" | tr -d ' '; }
result_of() { awk -F'\t' -v u="$1" -v r="$RUN" '$2==u && $8==r {o=$6} END {print o}' data/freemotion-submissions.tsv; }
close_open() { node lib/freemotion-submissions.mjs finalize --url "$1" --outcome errored --run-id $RUN --notes "$2" > /dev/null 2>&1; }

# ── driver availability ─────────────────────────────────────────────────
out_until() { cat "$OUT/$1" 2>/dev/null || echo 0; }
mark_out() {  # <driver> <epoch> <why>
  echo "$2" > "$OUT/$1"
  echo "note: $1 out until $(date -d @$2 '+%a %H:%M') ($3)"
  # Every limit hit, for "how many applications per window" (usage.mjs --drivers).
  printf '%s\t%s\t%s\t%s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u -d @$2 +%Y-%m-%dT%H:%M:%SZ)" "$3" >> tmp/fm/usage/limit-hits.tsv
}
# Sonnet jobs started in the last 5 hours, and when the oldest of them leaves the window.
sonnet_used() { awk -F'\t' -v s="$(date -u -d '-5 hours' +%Y-%m-%dT%H:%M:%SZ)" '$4=="sonnet" && $2>=s' tmp/fm/usage/night-runs.tsv 2>/dev/null | wc -l; }
sonnet_free_at() {
  local t; t=$(awk -F'\t' -v s="$(date -u -d '-5 hours' +%Y-%m-%dT%H:%M:%SZ)" '$4=="sonnet" && $2>=s {print $2}' tmp/fm/usage/night-runs.tsv 2>/dev/null | sort | head -1)
  [ -n "$t" ] && echo $(( $(date -d "$t" +%s) + 18000 + 60 )) || date +%s
}
usable() {  # <driver> -> 0 if it may take a job now
  [ "$(out_until $1)" -gt "$(date +%s)" ] && return 1
  [ "$1" = sonnet ] && [ "$(sonnet_used)" -ge "$SONNET_MAX" ] && return 1
  return 0
}
driver() { for d in $ORDER; do usable $d && { echo $d; return; }; done; echo none; }
next_free() {  # earliest epoch any driver in ORDER comes back
  local best=0 t
  for d in $ORDER; do
    t=$(out_until $d); [ "$d" = sonnet ] && [ "$(sonnet_used)" -ge "$SONNET_MAX" ] && { s=$(sonnet_free_at); [ "$s" -gt "$t" ] && t=$s; }
    { [ "$best" = 0 ] || [ "$t" -lt "$best" ]; } && best=$t
  done
  echo $best
}

# ── drivers ─────────────────────────────────────────────────────────────
run_agy() {  # <num> <model or empty> <file prefix>
  agy -p "$(prompt $1)" ${2:+--model "$2"} --dangerously-skip-permissions --print-timeout 20m --output-format json > "tmp/fm/usage/$3-$1.json" 2> "tmp/fm/usage/$3-$1.err"
}
run_codex() {
  timeout 1500 codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C "$ROOT" --json \
    ${CODEX_MODEL:+-m "$CODEX_MODEL"} ${CODEX_EFFORT:+-c model_reasoning_effort="\"$CODEX_EFFORT\""} \
    -o "tmp/fm/usage/codex-$1.txt" "$(prompt $1)" < /dev/null > "tmp/fm/usage/codex-$1.json" 2> "tmp/fm/usage/codex-$1.err"
}
run_copilot() {
  timeout 1500 copilot -p "$(prompt $1)" --allow-all --no-ask-user --no-color --output-format json \
    --additional-mcp-config "@$ROOT/.mcp.json" ${COPILOT_MODEL:+--model "$COPILOT_MODEL"} \
    ${COPILOT_MAX_CREDITS:+--max-ai-credits "$COPILOT_MAX_CREDITS"} \
    < /dev/null > "tmp/fm/usage/copilot-$1.json" 2> "tmp/fm/usage/copilot-$1.err"
}
run_sonnet() {
  timeout 1500 claude -p "$(prompt $1)" --model sonnet --dangerously-skip-permissions --output-format json > "tmp/fm/usage/sonnet-$1.json" 2> "tmp/fm/usage/sonnet-$1.err"
}
run_sonnet1() {
  CLAUDE_CONFIG_DIR="$CLAUDE1_DIR" timeout 1500 claude -p "$(prompt $1)" --model sonnet --dangerously-skip-permissions --output-format json > "tmp/fm/usage/sonnet1-$1.json" 2> "tmp/fm/usage/sonnet1-$1.err"
}
run_driver() {  # <driver> <num>
  case $1 in
    sonnet1) run_sonnet1 $2 ;;
    agy) run_agy $2 "" agy ;;
    agy-sonnet) run_agy $2 "$AGY_SONNET_MODEL" agy-sonnet ;;
    codex) run_codex $2 ;;
    copilot) run_copilot $2 ;;
    sonnet) run_sonnet $2 ;;
  esac
}
# Did <driver> stop on its usage limit for job <num>? Prints the epoch it resets, else nothing.
# The order is re-read before every job, so a driver that is back takes priority again at once.
# When the reset time is not in the message, look again after RECHECK (1 h): a driver still out
# refuses at once, so a look costs almost nothing, and a guessed 24 h would waste a real reset.
RECHECK=3600
limit_reset() {
  local d=$1 n=$2 now secs rs h m t dd
  now=$(date +%s)
  case $d in
    agy|agy-sonnet)
      grep -qiE 'quota|rate.?limit|resource.?exhausted|limit (reached|exceeded)|usage limit|exceeded your|429' "tmp/fm/usage/$d-$n.json" "tmp/fm/usage/$d-$n.err" 2>/dev/null || return
      # agy says when it resets ("Resets in 1h30m48s"), for the 5-hour and the weekly limit alike.
      rs=$(grep -ohE 'Resets in ([0-9]+d ?)?([0-9]+h)?([0-9]+m)?' "tmp/fm/usage/$d-$n.json" "tmp/fm/usage/$d-$n.err" 2>/dev/null | head -1)
      [ -z "$rs" ] && { echo $(( now + RECHECK )); return; }
      dd=$(echo "$rs" | grep -oE '[0-9]+d' | tr -d d); h=$(echo "$rs" | grep -oE '[0-9]+h' | tr -d h); m=$(echo "$rs" | grep -oE '[0-9]+m' | tr -d m)
      echo $(( now + ${dd:-0} * 86400 + ${h:-0} * 3600 + ${m:-0} * 60 + 120 )) ;;
    codex)
      # Only error output and error events: the event log also carries the posting's own text.
      { cat "tmp/fm/usage/codex-$n.err" 2>/dev/null; grep -E '"type":"(error|turn\.failed)"' "tmp/fm/usage/codex-$n.json" 2>/dev/null; } \
        | grep -qiE 'usage limit|rate.?limit|quota|limit reached|try again (at|in)|429' || return
      echo $(( now + RECHECK )) ;;
    copilot)
      { cat "tmp/fm/usage/copilot-$n.err" 2>/dev/null; grep -E '"type":"[a-z._]*error' "tmp/fm/usage/copilot-$n.json" 2>/dev/null; } \
        | grep -qiE 'usage limit|rate.?limit|quota|premium request|ai credits|credit limit|limit reached|exceeded|429' || return
      echo $(( now + RECHECK )) ;;
    sonnet|sonnet1)
      grep -qiE 'hit your (session|weekly|usage) limit|session limit|usage limit' "tmp/fm/usage/$d-$n.json" 2>/dev/null || return
      # "resets 12:10am (Europe/Paris)": that clock time today, or tomorrow if it has passed.
      rs=$(grep -oE 'resets [0-9]{1,2}(:[0-9]{2})? ?[ap]m' "tmp/fm/usage/$d-$n.json" | head -1 | sed 's/resets //')
      t=$( [ -n "$rs" ] && date -d "$rs" +%s 2>/dev/null )
      if [ -n "$t" ]; then [ "$t" -le "$now" ] && t=$(( t + 86400 )); echo $(( t + 120 ))
      else echo $(( now + RECHECK )); fi ;;
  esac
}

for n in "$@"; do
  if [ -f tmp/fm/night/stop ]; then rm -f tmp/fm/night/stop; echo "note: stop file found before job $n; stopping"; break; fi
  u=$(url_of $n)
  prev=$(result_of "$u")
  # Retry jobs that only failed because a limit or the network cut them off; skip everything else that has a result.
  note=$(awk -F'\t' -v u="$u" -v r="$RUN" '$2==u && $8==r {o=$9} END {print o}' data/freemotion-submissions.tsv)
  if [ -n "$prev" ] && [ "$prev" != "in-progress" ] && ! { [ "$prev" = errored ] && echo "$note" | grep -qiE 'limit hit|out of quota|network failure|usage limit|limit mid'; }; then echo "job $n: already $prev (skipped)"; continue; fi
  for attempt in $(seq 1 40); do
    d=$(driver)
    if [ "$d" = none ]; then
      if [ "$NDRIVERS" = 1 ]; then echo "note: $ORDER is out at job $n; single-driver run, stopping"; break 2; fi
      until_t=$(next_free); wait_s=$(( until_t - $(date +%s) )); [ $wait_s -gt 3600 ] && wait_s=3600; [ $wait_s -lt 60 ] && wait_s=60
      echo "note: every driver is out at job $n; waiting $(( wait_s / 60 )) min ($(date '+%H:%M'))"
      sleep $wait_s; continue
    fi
    start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    run_driver $d $n
    reset=$(limit_reset $d $n)
    if [ -n "$reset" ] && [ "$(result_of "$u")" != submitted ]; then
      mark_out $d $reset "limit hit on job $n"
      [ "$(result_of "$u")" = in-progress ] && close_open "$u" "$d usage limit mid-job; handing to the next driver"
      [ "$d" = sonnet ] && printf '%s\t%s\t%s\t%s\n' "$n" "$start" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$d" >> tmp/fm/usage/night-runs.tsv
      continue
    fi
    printf '%s\t%s\t%s\t%s\n' "$n" "$start" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$d" >> tmp/fm/usage/night-runs.tsv
    if grep -qiE 'no such host|network issue|Eligibility check failed|ENOTFOUND|ECONNRESET|connection (error|refused)' "tmp/fm/usage/$d-$n.json" "tmp/fm/usage/$d-$n.err" 2>/dev/null && [ "$(result_of "$u")" != submitted ]; then
      [ "$(result_of "$u")" = in-progress ] && close_open "$u" "network failure mid-run (attempt $attempt); retrying"
      echo "note: network problem on job $n (attempt $attempt), waiting 5 min"; sleep 300; continue
    fi
    break
  done
  [ "$(result_of "$u")" = in-progress ] && close_open "$u" "run ended without recording a result; check before any retry"
  echo "job $n ($d): $(result_of "$u")"
done
# Always: 3 random letters written this run, to skim (nothing to approve).
node letter-write.mjs --sample 3 --since "$RUN_START" || true
# Always: what the inbox says about this run's applications (HelloWork "arrivée" /
# "finalisez" / "transmise" emails, employer confirmations) next to our records. Report
# only: `python freemotion-night/check-sent.py --fix` corrects the records.
sleep 120   # the last confirmation emails take a minute or two
python freemotion-night/check-sent.py --days 1 --run "$RUN" || true
echo "ALL DONE"
