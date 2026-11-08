# session-sync

When you run several Claude Code sessions at once, two of them often work on the same thing. One
session settles a question; the other does not know and goes on with the old answer. session-sync
lets sessions on one topic see each other's decisions. It runs only when you send a message, and it
makes no model call of its own in the normal case.

The words the model reads are in Chinese (the author's working language).

## How it works

All state is local, under `~/.claude/session-sync/`. Each session writes only its own files, so two
sessions never write the same file:

| File | Holds |
|---|---|
| `log/<session>.jsonl` | Topics the session joined, decisions recorded there, files it edited, and (once on a topic) what you said |
| `seen/<session>.json` | How far this session has been shown the other sessions' entries |

Nothing goes into git. Worktrees sit on different branches, so a file in git reaches another session
only after a commit, a push and a pull.

**Write.** The model gets three tools, listed up front:

- `mcp__session-sync__topic`: join a topic. It returns the sessions already on it and what they
  recorded.
- `mcp__session-sync__decision`: record a line on a topic: you decided (`decided`), you overturned
  something (`overturned`), the agent proposed (`proposed`), or a convergence result (`converged`),
  with your own words.
- `mcp__session-sync__read`: read a topic in full, for convergence.

A short system-prompt section tells the model when to call them.

**Fallback.** When a turn ends, you seemed to settle something (you answered a question, or your
reply starts with words such as "好", "就这样", "改成", "选 B", "ok", "lgtm"), the session is on a
topic, and nothing was recorded, the mod forks the session once over its warm prompt cache and
records what the fork finds.

**Read.** When you send a message, the prompt carries, beside your words:

- decisions that other sessions recorded on this session's topics since this session last saw them,
  with the instruction to stop and tell you first if they disagree with what this session is doing;
- other sessions' edits, in the last 6 hours, to files this session also edited (keyed by
  repository, so the same file in two worktrees matches);
- while this session has joined no topic, the topics of the last 7 days it has not been shown yet.

The main model of the session judges whether a decision conflicts. It holds the whole session, so
no second model call is needed.

**Converge.** Say "收敛一下 <topic>" or run `/converge <topic>`. The model reads the topic, lists
what agrees, what disagrees (both sides' words and session ids) and what only one session discussed,
asks you about each disagreement, and records the result as `converged`. The other sessions see it
at their next message.

## What it does not do

- Sessions from `claude -p` and the SDK (cron jobs among them) take no part.
- It sends nothing to other sessions on its own. A session hears of a change only when you next
  write in it.
- Subagents do not join topics or record decisions.

## Install

```
/plugin marketplace add lycfyi/yskills
/plugin install session-sync@yskills
```

Or link `mods/session-sync` to `~/.claude/skills/session-sync`. Install it one way only.

## Develop

```
claude plugin validate mods/session-sync && claude plugin test mods/session-sync
```

The logic without `$` is in `hooks/lib.ts`, and most tests call it directly.
