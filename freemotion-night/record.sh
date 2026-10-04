#!/usr/bin/env bash
# freemotion-night/record.sh <run-id> <num> <slug> <company> <role> <url> <note>
# Kept for older sheets and habits: the work is in freemotion-night/record.mjs (Node), which agents
# should call directly. From PowerShell or cmd, `bash` can be WSL's and cannot run this file.
exec node "$(dirname "$0")/record.mjs" "$@"
