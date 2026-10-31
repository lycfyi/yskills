# hud

A heads-up display for Claude Code, drawn above the prompt. It shows how full the context is, the state
of your repos, how far the current turn has got and how long it will take. When you step away and come
back, it tells you where the session stopped and can run `/whats-next` for you.

It follows the "dark cockpit" of Airbus ECAM displays: quiet while all is well. Yellow means late or
near a limit, cyan means an action for you, green means the session can be closed.

```
context ⛁ ⛀ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ 15% · 151k/1000k · $2.28 · 5h 2% · 7d 6%
repo    my-app main ↑1 · others 1 · mine 2
task    read the parser ▱▱▱▱▱ · est 12 min · 14:32
recap   Goal: add a retry to the upload job
        Last: tests written, not run yet
         Next  run the test suite
breaks  eyes 3m · breathe 12m · push-ups 41m
```

## Rows

| Row | Shows | When |
|---|---|---|
| `context` | Context use with the `/context` glyphs (⛁ full, ⛀ part, ⛶ empty), tokens used / window, session cost, 5-hour and 7-day limits, the last compaction (`compacted 14:02 180k→30k`). Yellow at 70%, red at 85%, with one toast at 85%. | Always, once the first reading arrives. |
| `repo` | Up to 3 repos: the one the session started in, plus any it edited. Branch, `(worktree)`, `↑ahead ↓behind` from the last fetch, and changes split into `mine` (files this session edited) and `others`. `clean` when there are none. | Inside a git repo. |
| `task` | The step the model is on, one cell per step (`2/9` past 8 steps), and one estimate at the start (`est 12 min`, plus a clock time when 10 minutes or more are left). After that only the cells, until it runs late: `3 min over`, in yellow. The spinner line shows the step too. | While the model reports progress; clears when the turn ends. |
| `recap` | Three lines: `Goal`, `Last`, `Next`. The `Next` label is in reverse video: green for `Safe to close`, yellow for `Don't close: …`, cyan for anything else. | After you have been away (see below). Clears when you start a turn yourself. |
| `breaks` | Minutes to each break that is on, soonest first; `due` when one is due. While a break runs, a two-row animation takes its place. | Only with timed breaks on. |

When the terminal is short of rows, `breaks` goes first, then `repo` and `task`. `context` and `recap`
stay.

## Away from the prompt

**Recap.** When the main conversation has been idle for the `/autonext` delay (10 minutes by default;
20 minutes with `/autonext off`), the HUD forks the session once and asks for the three recap lines. A pending question, uncommitted work or an
undeployed change counts as a next step. Only finished, verified work gets `Safe to close`.

**Auto whats-next.** After the recap, it runs `/whats-next` once, as if you had typed it. It waits
while a turn is running, a background task has not reported back, a subagent is running, or the prompt
holds a draft. After one run it waits until you type something yourself.

It picks the command in this order:

1. `HUD_WHATS_NEXT_COMMAND`, if set.
2. `/whats-next`, if a skill or command has that name.
3. Any `/<plugin>:whats-next`, such as `/yskills:whats-next`.
4. None: the recap alone, with one line in the debug log and nothing in the transcript.

A `/whats-next` you type (either name) and the model calling the whats-next skill both count as a run.
`whats-next` is in [yskills](https://github.com/lycfyi/yskills).

**Done note** (off by default). When the recap's next step is `Safe to close`, the HUD forks once more
for three lines and writes them to `~/.claude/hud/done-log/<session>-<YYYYMMDD-HHMMSS>.md`:

```
## 2026-10-31 18:20 · my-app · add a retry to the upload job

- Done: retry with backoff in the upload job; PR #42 merged
- Status: deployed and verified with a test upload
- Left open: none
```

If `HUD_DONE_CMD` is set, it then runs that program once, with the note's path as its only argument.
There is at most one note per absence.

## The rest

- **Progress tool.** The model gets a tool, `mcp__hud__progress`, and a short system-prompt section
  that asks it to report steps and minutes. With no step done, the HUD trusts the model's estimate.
  As steps finish, the actual pace counts more. After three estimated turns, new estimates are scaled
  by the median of how far off the last ones were (0.5× to 4×).
- **Compaction.** It adds four lists to the compaction instructions: decisions you made, what you
  authorized, the task in progress, and the files changed. Before a real compaction, it saves your own
  messages and the changed files to `~/.claude/hud/notes/<session>/<time>.md`. A subagent's
  compaction is left alone.
- **Breaks.** Breathing: 5.5 s in, 5.5 s out, five times. Eyes: look 20 ft (6 m) away for 20 s.
  Push-ups: 10 in one minute. A timed break starts only after the model has worked for 20 seconds, so
  you are waiting anyway. Breaks come one at a time, at least 5 minutes apart, most overdue first.
  The breathing line is after [Mindful-Claude](https://github.com/halluton/Mindful-Claude) (MIT); the
  code here is new.

## Install

At the prompt of a terminal session:

```
/plugin marketplace add lycfyi/yskills
/plugin install hud@yskills
```

From a clone, you can also try it for one session with `claude --plugin-dir mods/hud`. To keep it, copy or link `mods/hud` to `~/.claude/skills/hud`.
Install it one way only: two copies draw two HUDs.

## Settings

Set these in your shell, or in the `env` block of `~/.claude/settings.json` or a project's
`.claude/settings.json`. Unset means the default.

| Variable | Value | Default |
|---|---|---|
| `HUD_LANG` | `zh` for Chinese | English |
| `HUD_RESTS` | `on` for timed breaks | off; `/breathe`, `/eyes` and `/pushups` still start one by hand |
| `HUD_DONE_LOG` | `on` to write done notes | off |
| `HUD_DONE_CMD` | A program to run after each done note, for example `~/bin/post-note`. No shell, `~/` is expanded, 60 s limit. | none |
| `HUD_WHATS_NEXT_COMMAND` | The command auto whats-next runs, with arguments, for example `/my-next --short` | found as above |

A command's choice (`/breathe off`, `/autonext 5`, `/donelog on`) is stored for all sessions and wins
over the variable.

A `HUD_DONE_CMD` that keeps every note in one file:

```sh
#!/bin/sh
cat "$1" >> "$HOME/done.md"
```

## Commands

| Command | Does |
|---|---|
| `/breathe` | One minute of breathing now. Type it again to stop. |
| `/eyes` | A 20-second eye break now. |
| `/pushups` | 10 push-ups now, one minute. |
| `/breathe off`, `on`, `<minutes>` | Turn the timed reminder off or on, or set its interval (5–240). Defaults: breathe 30, eyes 20, push-ups 60. Same for `/eyes` and `/pushups`. |
| `/autonext` | Show the state. `off`, `on`, or `<minutes>` (1–60, default 10). |
| `/donelog` | Show the state. `off` or `on`. |

`/autonext` and `/donelog` exist only in interactive sessions.

## Costs

- **Recap:** one forked call per absence, per session, on the session's model. It reads the prompt
  cache while that is still warm. Ten sessions left idle make ten calls.
- **Auto whats-next:** one whats-next turn per absence, per session, even if you never come back. Turn
  it off with `/autonext off`.
- **Done note:** one more forked call per closable absence, only when it is on.
- **Progress:** the tool and its prompt section (about 210 words) go with every request, in every
  session, `-p` included. Each step is one small tool call.
- **Repo row:** `git rev-parse` and `git status` per repo, at the start and after edits.
- Compaction notes and breaks make no model calls.

## Known limits

- The task row depends on the model calling the progress tool. When steps differ in size or the plan
  grows, the time left jumps.
- Only edits made with Edit, Write or NotebookEdit count as `mine`. A file written from Bash counts as
  `others`.
- Ahead and behind come from the last `git fetch`; the HUD never fetches.
- The break animation draws only in a terminal. Desktop and VS Code show the `breaks` row, but timed
  breaks do not start there.
- The HUD cannot tell whether you did the push-ups.
- Done notes are written only in a terminal session, and only after an absence. If you close the
  session right after `Safe to close`, there is no note.
- If you pick a whats-next option that starts work and then leave again, it does not run again until
  you type.
- Settings made with commands apply to every session and every repo.
- Recap and whats-next do not run in `-p` or SDK sessions.

## Turn it off in one repo

In that repo's `.claude/settings.local.json` (or `.claude/settings.json` to share it):

```json
{ "enabledPlugins": { "hud@yskills": false } }
```

Use `hud@skills-dir` if you installed it into `~/.claude/skills`.

## Change and test

```
claude plugin validate mods/hud
claude plugin test mods/hud
```

`tsc -p mods/hud` type-checks it after `claude --plugin-dir mods/hud` has loaded it once; loading writes
the types to `.claude-plugin/types/`.

- `hooks/register.tsx`: every call on `$` (the engine) lives here.
- `hooks/text.ts`: all strings, in one table per language, and the pure formatting.
- `hooks/pace.ts`: numbers only: estimates, break timing, the breathing line.
- `hooks/rest.tsx`: the break animation.
- `types/index.d.ts`: the session state.

To add a language, add a table to `TEXT` in `hooks/text.ts` and a case to `langOf`. The tests check
that the tables have the same entries.

## License

MIT.

## 中文

设 `HUD_LANG=zh`，提示符上方的字、命令说明、进度工具说明和压缩指令都换成中文。

- 提示符上方画 context、仓库、这一轮的进度和预估时间。
- 离开后写三行 recap（在做 / 停在 / 下一步），离开 10 分钟自动跑一次 whats-next。
- 压缩时保住决定和授权；收尾记录和定时休息默认关，要用时自己打开。
