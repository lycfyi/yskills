---
name: human-context-rebuild
description: Rebuild the user's mental model of the current session with a tight recap — what we're doing, why, and where we are. Use this to recover after a break, a tangent, or a long subagent run. Trigger when the user invokes /human-context-rebuild, or says "remind me what we're doing", "我忘了", "我们到哪一步了", "where are we", "what was I doing", "summarize this session", "我们在干啥来着", "这是啥来着", "这个是干嘛的来着", "想不起来这个 session 在做什么", "脑子糊了", or similar re-orientation cues — including a bare "?" or "这是啥" pointing at the current work. Default to firing when the user signals lost context about the session itself; the cost of an unneeded recap is low. Do NOT trigger for "explain this code", "summarize this file", or any task-summary request — those are different.
license: MIT
---

# Human Context Rebuild

## Purpose

Drop the user back into the session in under 30 seconds of reading. They forgot. Their job is to scan and resume — not to re-read a transcript.

Produce one short recap. No preamble, no "great question", no offering to do more.

## Output structure

Use exactly these sections, in this order. Skip a section only if there's genuinely nothing to put in it (don't pad).

```
**现在在做 / Now**: <1 line — the active task in concrete terms>
**为什么 / Why**: <1 line — the trigger or motivation the user gave>
**目标 / Goal**: <1 line — the success condition>
**进展 / Done**: <bullet list, ≤4 items, most recent first>
**下一步 / Next**: <1–2 lines — the very next action or open decision>
**Open questions** (only if blocking): <bullets>
```

Total length: aim for under 150 words. Hard cap 250.

## Language

Match the session's dominant language. If the user has been mixing Chinese and English, mix in the recap too — keep technical terms (file paths, function names, statuses) in their original form. Don't translate identifiers.

## What to include

- **Concrete anchors**: file paths, function names, branch names, decisions the user explicitly confirmed. These are what the user's brain latches onto faster than prose.
- **Decisions made**, especially scope changes ("user dropped quota, kept only AI judge").
- **The most recent meaningful action**: what the last tool call or agent run actually produced.

## What to leave out

- Tool-call mechanics (which agent ran, how many files were grep'd).
- Detailed code or SQL — link to the file path instead.
- Praise, hedges, "let me know if…", or offers to continue. The user can see the next step; they'll drive.
- Things the user already said in this turn. Don't echo their own message back.
- Re-justification of past decisions. State them as settled.

## Edge cases

- **Very new session (under ~3 turns)**: say so directly. Example: `我们才刚开始 — 你给的方向是 X, 还没动手. 要不要先 ___?`
- **Session changed topics mid-way**: recap the *current* topic only. Mention the prior topic in one line if it's still open: `(早些时候在弄 Y, 暂停了.)`
- **Just finished a big chunk of work**: lead Progress with what shipped, then Next with verification or the follow-up commit.
- **In the middle of a blocked tool call or pending question**: put the blocker in **Open questions** and make Next be "answer the question above".

## Self-check before sending

- Could the user paste this into a new conversation and pick up the thread? If not, add the missing anchor.
- Is anything in the recap something they explicitly said this turn? Cut it.
- Over 250 words? Cut Progress bullets first, then trim Why.
