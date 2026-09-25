#!/usr/bin/env bash
# freemotion-night/run.sh <num>... — overnight queue, one job at a time.
# Hands each sheet tmp/fm/night/job-<num>.md (written by make-jobs.mjs) to a fresh agent session.
# Driver: agy by default. When agy reports its quota is used up, the same job is
# rerun with Claude Sonnet, and Sonnet keeps driving: for 5 hours after a 5-hour-limit
# hit (then agy is tried again), or for the rest of the night after a weekly-limit hit.
# Skips jobs that already have a final result in this run. Retries network failures.
# Prints one line per job: "job N (driver): outcome".
cd "$(dirname "$0")/.."
ROOT=$(pwd -W 2>/dev/null || pwd)   # Windows-style path when available, for the agent prompt
RUN=$(cat tmp/fm/night/run-id 2>/dev/null) || { echo "no tmp/fm/night/run-id: run freemotion-night/make-jobs.mjs first"; exit 1; }
FLAG=tmp/fm/night/use-sonnet      # contents: "5h <epoch>" or "weekly <epoch>"
mkdir -p tmp/fm/usage
prompt() { echo "Read the file $ROOT/tmp/fm/night/job-$1.md and carry out the task it describes, from start to finish, without stopping to ask."; }
RUN_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)  # the end-of-run letter sample covers this run only
url_of() { grep -m1 -oE '^   https?://\S+' "tmp/fm/night/job-$1.md" | tr -d ' '; }
result_of() { awk -F'\t' -v u="$1" -v r="$RUN" '$2==u && $8==r {o=$6} END {print o}' data/freemotion-submissions.tsv; }
close_open() { node lib/freemotion-submissions.mjs finalize --url "$1" --outcome errored --run-id $RUN --notes "$2" > /dev/null 2>&1; }
driver() {
  if [ -f "$FLAG" ]; then
    read kind at < "$FLAG"
    if [ "$kind" = "5h" ] && [ $(( $(date +%s) - at )) -ge 18000 ]; then rm -f "$FLAG"; echo agy; return; fi
    echo sonnet; return
  fi
  echo agy
}
run_agy() {
  agy -p "$(prompt $1)" --dangerously-skip-permissions --print-timeout 20m --output-format json > "tmp/fm/usage/agy-$1.json" 2> "tmp/fm/usage/agy-$1.err"
}
run_sonnet() {
  timeout 1500 claude -p "$(prompt $1)" --model sonnet --dangerously-skip-permissions --output-format json > "tmp/fm/usage/sonnet-$1.json" 2> "tmp/fm/usage/sonnet-$1.err"
}
for n in "$@"; do
  u=$(url_of $n)
  prev=$(result_of "$u")
  # Retry jobs that only failed because a limit or the network cut them off; skip everything else that has a result.
  note=$(awk -F'\t' -v u="$u" -v r="$RUN" '$2==u && $8==r {o=$9} END {print o}' data/freemotion-submissions.tsv)
  if [ -n "$prev" ] && [ "$prev" != "in-progress" ] && ! { [ "$prev" = errored ] && echo "$note" | grep -qiE 'limit hit|out of quota|network failure'; }; then echo "job $n: already $prev (skipped)"; continue; fi
  for attempt in $(seq 1 40); do
    d=$(driver); start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [ "$d" = agy ]; then
      run_agy $n
      if grep -qiE 'quota|rate.?limit|resource.?exhausted|limit (reached|exceeded)|usage limit|exceeded your|429' "tmp/fm/usage/agy-$n.json" "tmp/fm/usage/agy-$n.err" 2>/dev/null && [ "$(result_of "$u")" != submitted ]; then
        if grep -qiE 'week' "tmp/fm/usage/agy-$n.json" "tmp/fm/usage/agy-$n.err" 2>/dev/null; then echo "weekly $(date +%s)" > "$FLAG"
        else
          # agy says when it resets ("Resets in 1h30m48s"); expire the flag then, not after 5h.
          rs=$(grep -oE 'Resets in ([0-9]+h)?([0-9]+m)?' "tmp/fm/usage/agy-$n.json" | head -1)
          h=$(echo "$rs" | grep -oE '[0-9]+h' | tr -d h); m=$(echo "$rs" | grep -oE '[0-9]+m' | tr -d m)
          secs=$(( ${h:-5} * 3600 + ${m:-0} * 60 + 120 )); echo "5h $(( $(date +%s) + secs - 18000 ))" > "$FLAG"
        fi
        echo "note: agy out of quota ($(cut -d' ' -f1 $FLAG)) at job $n, switching to sonnet"
        [ "$(result_of "$u")" = in-progress ] && close_open "$u" "agy ran out of quota mid-job; handing to sonnet"
        run_sonnet $n; d=sonnet
      fi
    else
      run_sonnet $n
    fi
    if [ "$d" = sonnet ] && grep -qiE 'hit your (session|weekly|usage) limit|session limit|usage limit' "tmp/fm/usage/sonnet-$n.json" 2>/dev/null; then
      # Sonnet shares the Claude allowance: wait for it (or for agy to come back) instead of racing the list.
      echo "note: Claude limit hit on job $n (attempt $attempt): $(grep -oE 'resets [^"]*' tmp/fm/usage/sonnet-$n.json | head -1); waiting 10 min"
      [ "$(result_of "$u")" = in-progress ] && close_open "$u" "Claude limit hit mid-run; retrying later"
      sleep 600; continue
    fi
    printf '%s\t%s\t%s\t%s\n' "$n" "$start" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$d" >> tmp/fm/usage/night-runs.tsv
    if grep -qiE 'no such host|network issue|Eligibility check failed|ENOTFOUND|ECONNRESET|connection (error|refused)' "tmp/fm/usage/$d-$n.json" "tmp/fm/usage/$d-$n.err" 2>/dev/null && [ "$(result_of "$u")" != submitted ]; then
      [ "$(result_of "$u")" = in-progress ] && close_open "$u" "network failure mid-run (attempt $attempt); retrying"
      echo "note: network problem on job $n (attempt $attempt), waiting 5 min"; sleep 300; continue
    fi
    break
  done
  [ "$(result_of "$u")" = in-progress ] && close_open "$u" "run ended without recording a result; check by hand before any retry"
  echo "job $n ($d): $(result_of "$u")"
done
# Always: 3 random letters written this run, to skim (nothing to approve).
node letter-write.mjs --sample 3 --since "$RUN_START" || true
echo "ALL DONE"
