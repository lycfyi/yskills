#!/usr/bin/env bash
# idle-return: when the user comes back to a session after a long gap, tell the agent
# to run the whats-next skill before handling the new message.
#
# Claude Code has no idle event, so three hooks share this script (stdin is the hook JSON):
#   idle-return.sh stop     # Stop: remember when the agent last finished a turn
#   idle-return.sh prompt   # UserPromptSubmit: if the gap is over the threshold, inject a note
#   idle-return.sh resume   # SessionStart (matcher "resume"): same check, using the transcript's mtime
#
# Settings (environment):
#   IDLE_RETURN_THRESHOLD   seconds away before the note fires; default 10800 (3 hours); 0 or off disables
#   IDLE_RETURN_LANG        language of the note the agent reads: en (default) or zh
#   IDLE_RETURN_STATE_DIR   where per-session timestamps live; default ~/.claude/state/idle-return
#
# Needs jq. Without jq it does nothing. It never blocks a prompt and always exits 0.
set -u
MODE="${1:-prompt}"
THRESHOLD="${IDLE_RETURN_THRESHOLD:-10800}"
case "$THRESHOLD" in off|0|'') exit 0 ;; *[!0-9]*) THRESHOLD=10800 ;; esac
command -v jq >/dev/null 2>&1 || exit 0
STATE_DIR="${IDLE_RETURN_STATE_DIR:-$HOME/.claude/state/idle-return}"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

INPUT="$(cat)"
SID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)"
TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)"
[ -n "$SID" ] || exit 0
case "$SID" in */*|.*) exit 0 ;; esac   # the session id becomes a file name
STAMP="$STATE_DIR/$SID"
NOW="$(date +%s)"

emit() {  # $1 = hookEventName, $2 = gap in seconds
  local h=$(( $2 / 3600 )) m=$(( ($2 % 3600) / 60 )) note
  if [ "${IDLE_RETURN_LANG:-en}" = zh ]; then
    note="[idle-return hook] 用户离开了 ${h} 小时 ${m} 分钟，刚回到这个 session。先调用 whats-next skill 帮用户续上下文，再处理这条消息。例外：如果这条消息本身就是一个明确的新任务，或用户明确说不用回顾，则跳过 whats-next 直接处理。"
  else
    note="[idle-return hook] The user was away for ${h}h ${m}m and just came back to this session. Run the whats-next skill first to re-orient them, then handle their message. Skip whats-next if the message is itself a clear new task, or if the user says they don't need a recap."
  fi
  jq -cn --arg ev "$1" --arg note "$note" \
    '{hookSpecificOutput: {hookEventName: $ev, additionalContext: $note}}'
}

# If the last thing in the transcript is a whats-next run (typed by the user, or called by the
# model) and the user hasn't typed anything since, the recap is already on screen: stay quiet.
already_shown() {
  [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || return 1
  local last
  last="$(tail -n 3000 "$TRANSCRIPT" | jq -r '
    def isnext: tostring | test("<command-name>/([a-z0-9-]+:)?whats-next</command-name>");
    if .type == "user" and (.message.content | type) == "string" then
      if (.message.content | isnext) then "N"
      elif (.origin.kind // "human") == "human" then "H"
      else empty end
    elif .type == "assistant" then
      (.message.content // [])
      | if type == "array" then .[] else empty end
      | select(.type == "tool_use" and .name == "Skill"
               and ((.input.skill // "") | test("(^|:)whats-next$")))
      | "N"
    else empty end
  ' 2>/dev/null | tail -n 1)"
  [ "$last" = "N" ]
}

case "$MODE" in
  stop)
    echo "$NOW" > "$STAMP"
    # Timestamps of sessions untouched for 30 days are no longer useful.
    find "$STATE_DIR" -type f -mtime +30 -delete 2>/dev/null
    ;;
  prompt)
    if [ -f "$STAMP" ]; then
      LAST="$(cat "$STAMP" 2>/dev/null || echo "$NOW")"
      case "$LAST" in ''|*[!0-9]*) LAST="$NOW" ;; esac
      GAP=$(( NOW - LAST ))
      if [ "$GAP" -ge "$THRESHOLD" ] && ! already_shown; then emit UserPromptSubmit "$GAP"; fi
    fi
    echo "$NOW" > "$STAMP"
    ;;
  resume)
    if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
      LAST="$(stat -f %m "$TRANSCRIPT" 2>/dev/null || stat -c %Y "$TRANSCRIPT" 2>/dev/null || echo "$NOW")"
      GAP=$(( NOW - LAST ))
      if [ "$GAP" -ge "$THRESHOLD" ] && ! already_shown; then emit SessionStart "$GAP"; fi
    fi
    echo "$NOW" > "$STAMP"
    ;;
esac
exit 0
