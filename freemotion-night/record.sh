#!/usr/bin/env bash
# freemotion-night/record.sh <run-id> <num> <slug> <company> <role> <url> <note>
# Records a CONFIRMED submission: closes the claim in data/freemotion-submissions.tsv
# and adds an Applied row to the tracker. Refuses any job not on this run's list
# (tmp/fm/night/allowed-urls.txt, written by make-jobs.mjs) and any note that
# reads like a failure, so a wrong call can't put a false "Applied" row in the tracker.
set -e
cd "$(dirname "$0")/.."
if [ $# -ne 7 ]; then
  echo "Usage: bash freemotion-night/record.sh <run-id> <num> <slug> <company> <role> <url> <note>"; exit 1
fi
RUN=$1; NUM=$2; SLUG=$3; CO=$4; ROLE=$5; URL=$6; NOTE=$7
if ! grep -qxF "$URL" tmp/fm/night/allowed-urls.txt; then
  echo "REFUSED: $URL is not on this run's job list. Nothing recorded."; exit 4
fi
if printf '%s' "$NOTE" | grep -qiE '^(failed|error)|404|not found|introuvable|could not|unable to'; then
  echo "REFUSED: the note reads like a failure, not a confirmation. Nothing recorded. Only record a job the site confirmed."; exit 4
fi
node lib/freemotion-submissions.mjs finalize --url "$URL" --outcome submitted --run-id "$RUN" --report - --notes "$NOTE" > /dev/null
printf '%s\t%s\t%s\t%s\tApplied\tN/A\t❌\t-\t%s Run %s.\t%s\n' "$NUM" "$(date +%F)" "$CO" "$ROLE" "$NOTE" "$RUN" "$URL" > "batch/tracker-additions/$NUM-$SLUG.tsv"
node merge-tracker.mjs 2>&1 | grep -E "Summary: \+" | head -1
grep -c "^| $NUM " data/applications.md
