#!/usr/bin/env bash
# Checks for hooks/idle-return.sh. Needs jq. Run from anywhere: scripts/test-idle-return.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$ROOT/hooks/idle-return.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export IDLE_RETURN_STATE_DIR="$T/state"
unset IDLE_RETURN_THRESHOLD IDLE_RETURN_LANG
fail=0

input() { printf '{"session_id":"%s","transcript_path":"%s"}' "$1" "$2"; }
away() { mkdir -p "$T/state"; echo $(( $(date +%s) - $2 )) > "$T/state/$1"; }
check() { # name, expected substring ("" = expect no output), actual output
  if [ -z "$2" ] && [ -z "$3" ]; then echo "ok   $1"
  elif [ -n "$2" ] && [ "${3#*"$2"}" != "$3" ]; then echo "ok   $1"
  else echo "FAIL $1: expected ${2:-no output}, got: ${3:-no output}"; fail=1; fi
}

printf '%s\n' '{"type":"user","message":{"content":"fix the login bug"}}' > "$T/plain.jsonl"
printf '%s\n' '{"type":"user","message":{"content":"hi"}}' \
  '{"type":"user","message":{"content":"<command-name>/yskills:whats-next</command-name>"}}' > "$T/typed-next.jsonl"
printf '%s\n' '{"type":"user","message":{"content":"hi"}}' \
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"whats-next"}}]}}' > "$T/skill-next.jsonl"
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"whats-next"}}]}}' \
  '{"type":"user","message":{"content":"ok, do option B"}}' > "$T/next-then-typed.jsonl"

out=$(input s1 "$T/plain.jsonl" | "$HOOK" stop)
check "stop writes a timestamp, prints nothing" "" "$out"
[ -f "$T/state/s1" ] || { echo "FAIL stop did not write $T/state/s1"; fail=1; }

out=$(input s1 "$T/plain.jsonl" | "$HOOK" prompt)
check "no note right after a turn" "" "$out"

away s2 14520
out=$(input s2 "$T/plain.jsonl" | "$HOOK" prompt)
check "note after 4 hours away" '"hookEventName":"UserPromptSubmit"' "$out"
check "note names the gap" "away for 4h 2m" "$out"

away s3 3600
out=$(input s3 "$T/plain.jsonl" | "$HOOK" prompt)
check "no note after 1 hour" "" "$out"

away s4 14400
out=$(input s4 "$T/typed-next.jsonl" | "$HOOK" prompt)
check "quiet when /yskills:whats-next was the last thing" "" "$out"

away s5 14400
out=$(input s5 "$T/skill-next.jsonl" | "$HOOK" prompt)
check "quiet when the model ran the whats-next skill last" "" "$out"

away s6 14400
out=$(input s6 "$T/next-then-typed.jsonl" | "$HOOK" prompt)
check "note when the user typed after whats-next" "whats-next" "$out"

away s7 14400
out=$(input s7 "$T/plain.jsonl" | IDLE_RETURN_LANG=zh "$HOOK" prompt)
check "Chinese note with IDLE_RETURN_LANG=zh" "用户离开了 4 小时" "$out"

away s8 14400
out=$(input s8 "$T/plain.jsonl" | IDLE_RETURN_THRESHOLD=0 "$HOOK" prompt)
check "IDLE_RETURN_THRESHOLD=0 turns it off" "" "$out"

away s9 120
out=$(input s9 "$T/plain.jsonl" | IDLE_RETURN_THRESHOLD=60 "$HOOK" prompt)
check "custom threshold" "away for 0h 2m" "$out"

touch -t 202001010000 "$T/plain.jsonl"
out=$(input s10 "$T/plain.jsonl" | "$HOOK" resume)
check "resume uses the transcript's age" '"hookEventName":"SessionStart"' "$out"

out=$(input "../escape" "$T/plain.jsonl" | "$HOOK" stop)
check "a session id with a slash is ignored" "" "$out"
[ -e "$T/escape" ] && { echo "FAIL wrote outside the state dir"; fail=1; }

out=$(printf 'not json' | "$HOOK" prompt; echo "rc=$?")
check "bad input exits 0" "rc=0" "$out"

[ "$fail" = 0 ] && echo "all idle-return checks passed"
exit "$fail"
