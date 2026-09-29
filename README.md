# yskills

Agent Skills I actually use, open-sourced one at a time.

All three solve the same problem from different angles: **you run many agent sessions in
parallel, you come back hours later, and every one of them greets you with a blank prompt** —
sitting in a worktree whose branch may have been merged, abandoned, or left far behind in the
meantime.

They follow the [Agent Skills](https://agentskills.io) open format, so they work in Claude
Code, Claude.ai, Codex, Cursor, OpenCode, Goose, and any other skills-compatible agent.

| Skill | Command | What it does |
| --- | --- | --- |
| [`whats-next`](skills/whats-next/SKILL.md) | `/whats-next` | Tells you whether the session can be closed, recaps it in 3–5 lines, then hands you the next step as clickable options |
| [`human-context-rebuild`](skills/human-context-rebuild/SKILL.md) | `/human-context-rebuild` | Pure recap, no decisions — a sub-30-second re-orientation in a fixed 5-field format |
| [`stale-check`](skills/stale-check/SKILL.md) | `/stale-check` | Says whether this branch/worktree is still worth working in — behind, merged (squash included), merged-then-kept-going, or about to conflict — and what would be lost if you dropped it |

**Which one do I want?** `human-context-rebuild` tells you where you are; `whats-next` tells
you where you are *and* hands you the next move as clickable options (plus a verdict on
whether the session can simply be closed). `stale-check` answers a narrower question about the
git side: is this branch still a valid place to work, and can the worktree go?

---

## Install

### Claude Code — plugin (recommended)

Installs every skill, keeps them updatable, and survives a machine rebuild.

```
/plugin marketplace add lycfyi/yskills
/plugin install yskills@yskills
```

Or without entering the REPL:

```bash
claude plugin marketplace add lycfyi/yskills
claude plugin install yskills@yskills
```

Plugin skills are namespaced by the plugin, so invoke them as `/yskills:whats-next`,
`/yskills:human-context-rebuild`, and `/yskills:stale-check`. Claude also triggers them automatically when you say things
like "我们到哪一步了" or "what should I do next".

Update later with `/plugin marketplace update yskills` then `/plugin update yskills`.

### Claude Code — plain files

If you'd rather not use plugins, drop the skill folders in and get the shorter
`/whats-next` command:

```bash
curl -fsSL https://raw.githubusercontent.com/lycfyi/yskills/main/install.sh | bash
```

That clones to a temp dir and copies every skill into `~/.claude/skills/`. From a clone:

```bash
git clone https://github.com/lycfyi/yskills.git && cd yskills
./install.sh                      # every skill -> ~/.claude/skills/
./install.sh whats-next           # just one
./install.sh --link               # symlink instead of copy, so edits track the repo
```

Or by hand — a skill is just a folder with a `SKILL.md`:

```bash
mkdir -p ~/.claude/skills
cp -r skills/whats-next skills/human-context-rebuild skills/stale-check ~/.claude/skills/
```

### Codex

Codex reads skills from `~/.agents/skills` (user level) and `.agents/skills` (repo level):

```bash
curl -fsSL https://raw.githubusercontent.com/lycfyi/yskills/main/install.sh | bash -s -- --agent codex
```

From a clone, `./install.sh --agent codex`, or manually:

```bash
mkdir -p ~/.agents/skills
cp -r skills/* ~/.agents/skills/
```

Restart Codex so it picks up the new skill metadata.

### Claude.ai, Claude Desktop, Cowork, and cloud sessions

These don't read `~/.claude/skills` on your machine — you upload the skill to your account
instead. Build the zips:

```bash
scripts/package.sh
# dist/whats-next.zip
# dist/human-context-rebuild.zip
# dist/stale-check.zip
```

Then upload each `.zip` under **Settings → Capabilities → Skills** on
[claude.ai](https://claude.ai) (or **Customize** in the Claude Desktop sidebar). Skills
enabled on your account are what Cowork and scheduled cloud sessions load at session start.

All skills stick to the six spec-allowed frontmatter fields, so they upload without the
`Unexpected key(s) in SKILL.md frontmatter` error that Claude Code-only fields cause.

### Cursor, OpenCode, Goose, and other agents

```bash
./install.sh --agent cursor        # ~/.cursor/skills
./install.sh --agent opencode      # ~/.config/opencode/skills
./install.sh --agent goose         # ~/.config/goose/skills
./install.sh --agent all           # every agent already present on this machine
./install.sh --dir /some/other/skills-dir
```

For anything not in that list, check where your agent looks for skills and point `--dir` at
it. The skill folders themselves are portable and need no changes.

### Project-scoped install

To make the skills available to everyone working in one repo (and to Claude Code cloud
sessions, which load skills committed to the cloned repository):

```bash
./install.sh --agent claude-project   # ./.claude/skills
./install.sh --agent codex-project    # ./.agents/skills
```

Then commit the result.

### Uninstall

```bash
rm -rf ~/.claude/skills/whats-next ~/.claude/skills/human-context-rebuild ~/.claude/skills/stale-check
# or, if installed as a plugin:
claude plugin uninstall yskills@yskills
claude plugin marketplace remove yskills
```

---

## The skills

### `whats-next`

You run many sessions in parallel. You come back after half a day and can't remember where
any of them stands — and every session greets you with a blank prompt.

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

It also works in a **fresh context with zero history**: point it at a worktree or branch
(`/whats-next` in a new session, or "这个 worktree 做到哪了") and it rebuilds the state from
git evidence instead — uncommitted diffs, branch commits vs. base, handoff/task docs — and
the verdict becomes "can this worktree be wrapped up (merged/PR'd/deleted)?"

### `human-context-rebuild`

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

### `stale-check`

You open a worktree you haven't touched in a week. Is the branch still worth working on? Was it
merged already? Did you commit something after the PR landed? `/stale-check` (or "is this branch
stale?", "这个 worktree 还能用吗", "哪些 worktree 该清了") runs a read-only git probe and answers in
one screen:

```
【LEFTOVER — merged, then kept going】feat/export-csv vs main: PR #2 merged a month ago, then
1 more commit landed on the branch and was never pushed.

- Main has nothing new besides the PR's own merge commit.
- Would be lost: 5f18a0d "feat(export): never report a partial export as complete" — only on
  this machine.
- Next: don't delete yet. Move 5f18a0d to a fresh branch off main and open a PR (rebase is clean).
```

The verdicts: **LEFTOVER** (PR merged, commits after it), **DEAD** (merged — fast-forward, rebase,
or squash — or PR closed), **REUSED** (merged branch with new uncommitted work on top),
**CONFLICTING**, **STALE**, **DRIFTING**, **FRESH**. Each report also names what would be lost:
unpushed and post-merge commits, dirty and untracked files. `--all-worktrees` sweeps every
worktree of the repo and marks the ones that can go.

It never rebases, merges, or deletes anything; the only side effect is `git fetch --prune`. It
detects squash merges from git alone (a multi-commit branch's combined diff matched against target),
and uses `gh` when available for PR state and post-merge commits. The target branch defaults to
`origin/HEAD`; override it with `--target develop` or `STALE_CHECK_TARGET`.

Six worked examples from real runs, names changed, are in
[`skills/stale-check/references/examples.md`](skills/stale-check/references/examples.md).

---

## Repo layout

```
yskills/
├── skills/                        # the skills themselves — portable, copy anywhere
│   ├── whats-next/SKILL.md
│   ├── human-context-rebuild/SKILL.md
│   └── stale-check/
│       ├── SKILL.md
│       ├── scripts/stale_check.sh    # the read-only git probe
│       └── references/examples.md    # worked examples, names changed
├── .claude-plugin/
│   ├── plugin.json                # Claude Code plugin manifest
│   └── marketplace.json           # marketplace catalog (this repo is its own marketplace)
├── install.sh                     # cross-agent installer
└── scripts/
    ├── validate.py                # Agent Skills spec validation
    └── package.sh                 # build dist/*.zip for claude.ai upload
```

## Contributing

Add a skill as `skills/<name>/SKILL.md`, with frontmatter limited to the six fields the
[spec](https://agentskills.io/specification) allows — `name`, `description`, `license`,
`compatibility`, `metadata`, `allowed-tools`. `name` must match the directory name, and
`description` must say both what the skill does *and* when it should trigger, in under 1024
characters. Anything beyond those fields is Claude Code-only and breaks claude.ai upload.

Then check it:

```bash
pip install pyyaml
python3 scripts/validate.py      # spec compliance
claude plugin validate .         # plugin + marketplace manifests
```

Both run in CI on every push and pull request.

## License

MIT
