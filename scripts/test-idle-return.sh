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

# Cleanup on stop removes only the hook's own old timestamps (named by session id), and only at
# the top of the state folder, so pointing IDLE_RETURN_STATE_DIR at a shared folder is safe.
gone() { if [ ! -e "$T/state/$2" ]; then echo "ok   $1"; else echo "FAIL $1: $2 is still there"; fail=1; fi; }
kept() { if [ -e "$T/state/$2" ]; then echo "ok   $1"; else echo "FAIL $1: $2 was deleted"; fail=1; fi; }
OLD=11111111-2222-3333-4444-555555555555
NEW=66666666-7777-8888-9999-000000000000
mkdir -p "$T/state/sub"
for f in "$OLD" notes.txt "sub/$OLD"; do echo 1 > "$T/state/$f"; touch -t 202001010000 "$T/state/$f"; done
echo 1 > "$T/state/$NEW"
input s11 "$T/plain.jsonl" | "$HOOK" stop >/dev/null
gone "cleanup removes an old session timestamp" "$OLD"
kept "cleanup keeps a recent session timestamp" "$NEW"
kept "cleanup keeps an old file with another name" notes.txt
kept "cleanup keeps an old file in a subfolder" "sub/$OLD"

[ "$fail" = 0 ] && echo "all idle-return checks passed"
exit "$fail"
