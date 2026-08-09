# yskill

Claude Code skills I actually use, open-sourced one at a time.

## whats-next

You run many Claude Code sessions in parallel. You come back after half a day and can't
remember where any of them stands — and every session greets you with a blank prompt.

Type `/whats-next` and the session re-orients you instead:

1. **First line, always: can this session be closed right now?** ("✅ safe to close — nothing
   running, everything on disk" / "⚠️ not yet — X is still running / Y only exists in this
   conversation"). If it's not closable, it names the single cheapest action that would make
   it closable.
2. A 3–5 line recap of what the session is about and where it stopped.
3. The next step as clickable choices (Yes/No, A/B/C/D) — concrete actions like "deploy to
   staging and run acceptance", never "continue the work". Pick one and it executes
   immediately. No blank prompt to fill in.

Rules baked into the prompt: only trust actual tool-call records (a step that was described
but never executed didn't happen); never fabricate results for anything still running; never
re-ask a decision that was already made.

## human-context-rebuild

The companion skill: a pure recap, no decisions. Type `/human-context-rebuild` (or just say
"remind me what we're doing" / "我们到哪一步了") and get a sub-30-second re-orientation:

```
**现在在做 / Now**: …
**为什么 / Why**: …
**目标 / Goal**: …
**进展 / Done**: …
**下一步 / Next**: …
```

Under 150 words, anchored on file paths, branch names, and confirmed decisions — the things
your brain latches onto faster than prose. Bilingual by design: it matches whatever language
the session is running in.

**Which one do I want?** `human-context-rebuild` tells you where you are;
`whats-next` tells you where you are *and* hands you the next move as clickable options
(plus a verdict on whether the session can simply be closed).

## Install

```bash
mkdir -p ~/.claude/skills
cp -r whats-next human-context-rebuild ~/.claude/skills/
```

Then type `/whats-next` or `/human-context-rebuild` in any Claude Code session.

## License

MIT
