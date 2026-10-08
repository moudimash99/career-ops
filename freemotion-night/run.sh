#!/usr/bin/env bash
# freemotion-night/run.sh <num>... — overnight queue, one job at a time.
# Hands each sheet tmp/fm/night/job-<num>.md (written by make-jobs.mjs) to a fresh agent session.
# Skips jobs that already have a final result in this run. Retries network failures.
# Prints one line per job: "job N (driver): outcome".
#
# Drivers, tried in this order for every job (the user's order, 2026-10-04):
#   agy          agy on its default model
#   codex        codex exec (the project's .codex/config.toml gives it the Playwright browser)
#   sonnet1      claude -p --model sonnet on the SECOND Claude subscription (CLAUDE1_DIR, default
#                ~/.claude-account1, or ~/.claude-account2 when this shell is on account1), which
#                no watching session uses: no cap.
#   copilot     GitHub Copilot CLI (see DRIVER=copilot below)
# Not in the default order, still there for DRIVER_ORDER / DRIVER:
#   agy-sonnet   agy on Claude Sonnet (agy's own Claude allowance, separate from the default model's)
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
# HEADFUL=1: the Camoufox window is visible for this run (to watch it, or step in), and hidden again
# when the run ends, on Ctrl+C, or at the start of the next run if this one was killed outright.
# lib/freemotion-browser-mode.mjs flips only "headless" in config/playwright-mcp-camoufox.json, the
# file every driver's browser reads; the disguise, executable and MCP version stay as they are.
# A Claude or agy session opened during the run gets the visible window too.
# WATCH=1: to watch one job and approve it step by step. The browser is visible, agy's browser goes through
# freemotion-night/browser-gate.mjs (every input into the page waits for your OK), and the watch window
# (freemotion-night/control.mjs) opens in your web browser: the action waiting, Continue / Don't do it +
# a message to agy / Stop, the plain log, "Page now" and agy's last screenshot, links to the CV and
# letter. Approve THERE, not in agy's terminal window (agy -i, which also opens). Close that window when
# agy writes DONE; the run then records and checks as usual. agy and agy-sonnet only.
# WATCH_HOST=lan: the watch window is reachable from other machines too, through a link with a secret key.
# Before every job, freemotion-night/prepare-docs.mjs makes that posting's CV and cover letter: it draws
# the two arms (CV generic 15 / loose 50 / strict 35, letter none 15 / short 35 / full 50), has them
# written and checked, and puts them into the sheet; the agent only uploads and pastes. About two
# minutes a job. Writers: the job's driver first, then agy, codex, the second Claude account, copilot
# (DOCS_WRITERS="codex agy" for another order). When none answers, the generic CV goes out with no letter.
# HelloWork postings: after the documents and before the agent, freemotion-night/sites/hellowork.mjs does
# HelloWork's own form without a model (claim, sign-in, name, CV, letter, "Postuler", the phone step) and
# writes what it did into the sheet; the agent then only records it, or continues on the employer's page,
# or from where the script stopped (issue #26). Once per job. NO_HW_SCRIPT=1 leaves HelloWork to the agent;
# a WATCH=1 run never uses it.
# Every agy job prints its steps live (freemotion-night/agent-log.mjs, agy's own labels and its
# "NEXT / WHY" lines) and keeps them in tmp/fm/night/actions-<num>.log.
cd "$(dirname "$0")/.."
if [ -n "$WATCH" ]; then
  HEADFUL=1; DRIVER=${DRIVER:-agy}
  case $DRIVER in agy|agy-sonnet) ;; *) echo "WATCH=1 works with agy only (DRIVER=agy or agy-sonnet)"; exit 1 ;; esac
fi
ROOT=$(pwd -W 2>/dev/null || pwd)   # Windows-style path when available, for the agent prompt
RUN=$(cat tmp/fm/night/run-id 2>/dev/null) || { echo "no tmp/fm/night/run-id: run freemotion-night/make-jobs.mjs first"; exit 1; }
# ── browser window ──────────────────────────────────────────────────────
# A visible window left behind by a run that was killed goes back first.
[ -f tmp/fm/browser-mode.json ] && node lib/freemotion-browser-mode.mjs restore
if [ -n "$HEADFUL" ]; then
  node lib/freemotion-browser-mode.mjs headful --run "$RUN" || { echo "could not make the browser window visible; stopping"; exit 1; }
  trap 'node lib/freemotion-browser-mode.mjs restore' EXIT
  trap 'exit 130' INT TERM HUP
fi
# ── browser gate (WATCH=1) ──────────────────────────────────────────────
# A watched run sends agy's browser through freemotion-night/browser-gate.mjs: every input into the page
# waits for the person in the watch window (control.mjs). Any other run uses the plain browser, and puts
# it back first if a watched run was killed before it could (a gate left in place would hold every action).
MCPV=$(grep -oE '@playwright/mcp@[0-9.]+' .mcp.json)
plain_agy_browser() { agy mcp add playwright npx -y "$MCPV" --config "$ROOT/config/playwright-mcp-camoufox.json" > /dev/null; }
agy mcp list 2>/dev/null | grep -q 'browser-gate' && { plain_agy_browser; echo "agy browser: the gate from an earlier watched run was still in place; back to the plain browser"; }
if [ -n "$WATCH" ]; then
  agy mcp add playwright node "$ROOT/freemotion-night/browser-gate.mjs" > /dev/null || { echo "could not put the browser gate in place; stopping"; exit 1; }
  trap 'plain_agy_browser; node lib/freemotion-browser-mode.mjs restore' EXIT
  echo "agy browser: through the gate (every input waits for you in the watch window)"
fi
BROWSER_MODE=$(node lib/freemotion-browser-mode.mjs show --mode-only) || { echo "could not read the browser mode; stopping"; exit 1; }
node lib/freemotion-browser-mode.mjs show
OUT=tmp/fm/night/out
mkdir -p tmp/fm/usage "$OUT"
ORDER=${DRIVER_ORDER:-agy codex sonnet1 copilot}
# sonnet1 must not be the account of the session watching the run: when this shell is itself on
# ~/.claude-account1, sonnet1 takes ~/.claude-account2 (user, 2026-10-04).
if [ -z "$CLAUDE1_DIR" ]; then
  HOME_W=$(cd ~ && (pwd -W 2>/dev/null || pwd))
  CLAUDE1_DIR=$HOME_W/.claude-account1
  case "$CLAUDE_CONFIG_DIR" in *[/\\].claude-account1|*[/\\].claude-account1[/\\]) CLAUDE1_DIR=$HOME_W/.claude-account2 ;; esac
fi
[ -n "$AGY_ONLY" ] && DRIVER=agy
[ -n "$DRIVER" ] && ORDER=$DRIVER
# agy's browser comes from agy's own MCP list (~/.gemini/config/mcp_config.json), not from .mcp.json.
# Without it every agy job ends at once with "I have no browser_* tools" (a new PC, 2026-10-04).
if echo " $ORDER " | grep -qE ' agy(-sonnet)? ' && ! agy mcp list 2>/dev/null | grep -qE '^playwright[[:space:]].*enabled'; then
  echo "agy has no 'playwright' browser server. Add it once with:"
  echo "  agy mcp add playwright npx -y $(grep -oE '@playwright/mcp@[0-9.]+' .mcp.json) --config $ROOT/config/playwright-mcp-camoufox.json"
  ORDER=$(echo $ORDER | tr ' ' '\n' | grep -vE '^agy(-sonnet)?$' | tr '\n' ' ')
  [ -z "${ORDER// }" ] && { echo "no driver left; stopping"; exit 1; }
  echo "note: running without agy: $ORDER"
fi
NDRIVERS=$(echo $ORDER | wc -w)
SONNET_MAX=${SONNET_MAX_PER_WINDOW:-8}
AGY_SONNET_MODEL=${AGY_SONNET_MODEL:-claude-sonnet-4-6}
prompt() {
  echo "Read the file $ROOT/tmp/fm/night/job-$1.md and carry out the task it describes, from start to finish, without stopping to ask."
  [ "$BROWSER_MODE" = headful ] && echo "The browser window is visible this run and a person may be watching it. Work exactly as usual."
  [ -n "$WATCH" ] && echo "A person is watching this run and approves every browser action that types, clicks, chooses or opens a page. Do ONE such action per tool call, with the plain tools (browser_click, browser_type, browser_select_option, browser_file_upload...) rather than page code, so they can see each step. If a browser tool answers WAITING FOR THE PERSON, call the same tool again with exactly the same arguments and do nothing else. If it answers NOT DONE with a message from the person, follow that message. If it answers STOPPED, stop at once. Never invent data, and never record a submission the site did not confirm. When the task is finished, write DONE."
}
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
  [ -n "$WATCH" ] && { run_agy_watch "$@"; return; }
  agy -p "$(prompt $1)" ${2:+--model "$2"} --dangerously-skip-permissions --print-timeout 20m --output-format json > "tmp/fm/usage/$3-$1.json" 2> "tmp/fm/usage/$3-$1.err"
}
# WATCH=1: the same prompt in an interactive agy session, in a new terminal window; returns when it closes.
run_agy_watch() {  # <num> <model or empty> <file prefix>
  local p="tmp/fm/night/watch-prompt-$1.txt" s="tmp/fm/night/watch-$1.sh"
  prompt $1 > "$p"
  printf 'cd "%s"\nagy -i "$(cat "%s")" %s--dangerously-skip-permissions\n' "$(pwd)" "$p" "${2:+--model \"$2\" }" > "$s"
  # The watch window: plain log, the action waiting for you, Continue / Don't / Stop.
  node freemotion-night/control.mjs --job $1 --since "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "tmp/fm/night/control-$1.out" 2>&1 &
  local ctl=$!
  sleep 1; cat "tmp/fm/night/control-$1.out"
  # The link the window printed (with its key when WATCH_HOST=lan makes it reachable from the network).
  local link; link=$(grep -m1 -oE 'http://127\.0\.0\.1:[0-9]+/[^ ]*' "tmp/fm/night/control-$1.out")
  cmd //c start "" "${link:-http://127.0.0.1:${WATCH_PORT:-4777}/}"
  echo "note: agy has its own window for job $1; close it (or /quit) when the job is done"
  cmd //c start "agy job $1" //wait "$(cygpath -w "$(command -v bash)")" "$(cygpath -w "$(pwd)/$s")"
  kill $ctl 2>/dev/null
  : > "tmp/fm/usage/$3-$1.json"   # no print-mode output in watch mode (limit checks find nothing)
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
      # Signed out (lesson L53, 2026-10-04): agy waits 60 s for a Google sign-in nobody can give,
      # then fails. The driver is out like at a limit; look again in an hour, not three tries now.
      if grep -qiE 'Authentication required|authentication (failed|timed out)' "tmp/fm/usage/$d-$n.err" 2>/dev/null; then
        echo "note: $d is signed out (Google sign-in); run \`agy\` once by hand to sign in again" >&2
        echo $(( now + RECHECK )); return
      fi
      grep -qiE 'quota|rate.?limit|resource.?exhausted|limit (reached|exceeded)|usage limit|exceeded your|(^|[^0-9])429([^0-9]|$)' "tmp/fm/usage/$d-$n.json" "tmp/fm/usage/$d-$n.err" 2>/dev/null || return
      # agy says when it resets ("Resets in 1h30m48s"), for the 5-hour and the weekly limit alike.
      rs=$(grep -ohE 'Resets in ([0-9]+d ?)?([0-9]+h)?([0-9]+m)?' "tmp/fm/usage/$d-$n.json" "tmp/fm/usage/$d-$n.err" 2>/dev/null | head -1)
      [ -z "$rs" ] && { echo $(( now + RECHECK )); return; }
      dd=$(echo "$rs" | grep -oE '[0-9]+d' | tr -d d); h=$(echo "$rs" | grep -oE '[0-9]+h' | tr -d h); m=$(echo "$rs" | grep -oE '[0-9]+m' | tr -d m)
      echo $(( now + ${dd:-0} * 86400 + ${h:-0} * 3600 + ${m:-0} * 60 + 120 )) ;;
    codex)
      # Only error output and error events: the event log also carries the posting's own text.
      { cat "tmp/fm/usage/codex-$n.err" 2>/dev/null; grep -E '"type":"(error|turn\.failed)"' "tmp/fm/usage/codex-$n.json" 2>/dev/null; } \
        | grep -qiE 'usage limit|rate.?limit|quota|limit reached|try again (at|in)|(^|[^0-9])429([^0-9]|$)' || return
      echo $(( now + RECHECK )) ;;
    copilot)
      { cat "tmp/fm/usage/copilot-$n.err" 2>/dev/null; grep -E '"type":"[a-z._]*error' "tmp/fm/usage/copilot-$n.json" 2>/dev/null; } \
        | grep -qiE 'usage limit|rate.?limit|quota|premium request|ai credits|credit limit|limit reached|exceeded|(^|[^0-9])429([^0-9]|$)' || return
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
  hw_ran=
  for attempt in $(seq 1 40); do
    d=$(driver)
    if [ "$d" = none ]; then
      if [ "$NDRIVERS" = 1 ]; then echo "note: $ORDER is out at job $n; single-driver run, stopping"; break 2; fi
      until_t=$(next_free); wait_s=$(( until_t - $(date +%s) )); [ $wait_s -gt 3600 ] && wait_s=3600; [ $wait_s -lt 60 ] && wait_s=60
      echo "note: every driver is out at job $n; waiting $(( wait_s / 60 )) min ($(date '+%H:%M'))"
      sleep $wait_s; continue
    fi
    # This posting's CV and letter (drawn arms, written and checked), put into the sheet, before the job's
    # clock and its live log start (the writers are agy sessions too). Made once per
    # posting and reused on a retry. A failure costs nothing: the sheet keeps the generic CV and no letter.
    CLAUDE1_DIR="$CLAUDE1_DIR" node freemotion-night/prepare-docs.mjs $n --driver $d || echo "note: no documents made for job $n: generic CV, no letter"
    # HelloWork's own form, without a model. Exit 2 (claim refused / company cap) or 3 (finalized by the
    # script): nothing left for an agent. 0: the sheet says what it did, the agent continues. 1: the agent does it all.
    if [ -z "$WATCH$NO_HW_SCRIPT$hw_ran" ] && echo "$u" | grep -qE '^https?://(www\.)?hellowork\.com/fr-fr/emplois/'; then
      hw_ran=1
      node freemotion-night/sites/hellowork.mjs $n ${HEADFUL:+--headful}; hw=$?
      if [ $hw = 2 ] || [ $hw = 3 ]; then d=hellowork; break; fi
    fi
    start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # agy's steps, live, from its own transcript (also kept in tmp/fm/night/actions-<num>.log).
    follower=
    case $d in agy|agy-sonnet) node freemotion-night/agent-log.mjs --job $n --since "$start" --follow --out "tmp/fm/night/actions-$n.log" & follower=$! ;; esac
    run_driver $d $n
    [ -n "$follower" ] && { sleep 2; kill $follower 2>/dev/null; wait $follower 2>/dev/null; }
    reset=$(limit_reset $d $n)
    if [ -n "$reset" ] && [ "$(result_of "$u")" != submitted ]; then
      mark_out $d $reset "limit hit on job $n"
      [ "$(result_of "$u")" = in-progress ] && close_open "$u" "$d usage limit mid-job; handing to the next driver"
      [ "$d" = sonnet ] && printf '%s\t%s\t%s\t%s\t%s\n' "$n" "$start" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$d" "$BROWSER_MODE" >> tmp/fm/usage/night-runs.tsv
      continue
    fi
    # 5th column: the browser window (headless | headful), to compare job times between the two.
    printf '%s\t%s\t%s\t%s\t%s\n' "$n" "$start" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$d" "$BROWSER_MODE" >> tmp/fm/usage/night-runs.tsv
    if grep -qiE 'no such host|network issue|Eligibility check failed|ENOTFOUND|ECONNRESET|connection (error|refused)' "tmp/fm/usage/$d-$n.json" "tmp/fm/usage/$d-$n.err" 2>/dev/null && [ "$(result_of "$u")" != submitted ]; then
      [ "$(result_of "$u")" = in-progress ] && close_open "$u" "network failure mid-run (attempt $attempt); retrying"
      echo "note: network problem on job $n (attempt $attempt), waiting 5 min"; sleep 300; continue
    fi
    break
  done
  [ "$(result_of "$u")" = in-progress ] && close_open "$u" "run ended without recording a result; check before any retry"
  echo "job $n ($d): $(result_of "$u")"
  # Only sent applications count in the CV and letter experiments.
  [ "$(result_of "$u")" = submitted ] && node freemotion-night/prepare-docs.mjs --sync > /dev/null
done
# Hidden again before the inbox check (the EXIT trap would do it too, two minutes later).
[ -n "$HEADFUL" ] && node lib/freemotion-browser-mode.mjs restore
# Always: 3 random letters written this run, to skim (nothing to approve).
node letter-write.mjs --sample 3 --since "$RUN_START" || true
# Always: what the inbox says about this run's applications (HelloWork "arrivée" /
# "finalisez" / "transmise" emails, employer confirmations) next to our records. Report
# only: `python freemotion-night/check-sent.py --fix` corrects the records.
sleep 120   # the last confirmation emails take a minute or two
python freemotion-night/check-sent.py --days 1 --run "$RUN" 2>&1 | tee "tmp/fm/night/check-sent-$RUN.txt" || true
# Always: what employers answered in the last 30 days (rejections, a recruiter who wants to talk), read
# from All Mail (archived mail included), matched to the tracker and APPLIED at once: the user asked not
# to be asked first (2026-10-08). Emails that name no single row are only listed.
python freemotion-night/inbox-replies.py && python freemotion-night/inbox-replies.py --apply all || true
# Always: follow-up drafts in Gmail's Drafts folder for applications 7+ days old with an acknowledgement to
# reply to (at most 20 a week, one per company), and the ones the user sent since logged in data/follow-ups.md.
# Nothing is sent: he reads and sends each draft from Gmail (followups.mjs; issue #19). NO_FOLLOWUPS=1 skips it.
[ -z "$NO_FOLLOWUPS" ] && { node freemotion-night/followups.mjs || true; }
# Always: what went wrong in this run, filed as lessons (data/lessons-learned.md) by one tool-free
# Claude Code call on the second account (lessons.mjs; issue #27). Never agy or a browser runner.
CLAUDE_CONFIG_DIR="${LESSONS_CLAUDE_DIR:-$CLAUDE1_DIR}" node freemotion-night/lessons.mjs review --run "$RUN" || true
# Always: what is waiting in the agent inbox (data/agent-inbox.md) for a person or a later session.
if grep -q '^- \[ \]' data/agent-inbox.md 2>/dev/null; then
  echo; echo "AGENT INBOX ($(grep -c '^- \[ \]' data/agent-inbox.md) open):"
  grep '^- \[ \]' data/agent-inbox.md | cut -c7-220 | sed 's/^/   /'
fi
echo "ALL DONE"
