---
name: worktree-cleanup
description: >-
  Actually remove finished git worktrees and their branches after they have been
  diagnosed: prove each one is merged (squash merges included) and clean, stop dev
  servers still running inside, remove the worktree and branch with plain git, prune
  dead registrations and empty shell folders, and report what was kept and why.
  Trigger when the user says "clean up my worktrees", "delete the merged ones",
  "remove this worktree and its branch", "帮我清理", "清一下 worktree", "把合过的都删了",
  "哪些 worktree 可以删，删掉", or asks to act on a stale-check verdict. NOT for
  diagnosing only (use stale-check), rebasing or moving work to a new branch, or
  deleting anything whose work is not on the target branch unless the user names it.
license: MIT
compatibility: Needs git and bash. Uses the GitHub CLI `gh` to recognize squash merges when available. Reads its inventory from the stale-check skill's script when that is installed.
---

# Worktree Cleanup

stale-check says what is dead; this skill removes it without losing anyone's work. Answer
in the user's language.

## Rules

- Remove only what is **proven merged and clean**. Unmerged commits, modified or untracked
  files, a stash made on the branch, or a process still running inside put it on a "needs
  your call" list. Never remove on inference.
- Never remove the main checkout (the first entry of `git worktree list`). If it sits on a
  merged feature branch, offer to switch it back to the target branch, and only if it is clean.
- Never `reset --hard`, `checkout -- .` or `clean -fd` to make a tree "clean". Dirty means stop.
- If a worktree manager (an IDE or an agent app) created the worktree, use its own delete
  command so its list stays in sync; the git commands below are the fallback. Managers often
  delete the local branch along with the worktree, and some refuse a branch with no upstream.
  Their force option is safe only after step 2 proved the merge.

## 1. Inventory

```bash
bash <stale-check-dir>/scripts/stale_check.sh <repo> --all-worktrees
```

Without stale-check, use `git -C <repo> worktree list --porcelain` and do step 2 by hand for
each entry. For several repos, loop over the ones the user named, or over the folder where
they keep their repos. Flags from the script: `temp_dir` (a tree under `/tmp`, `$TMPDIR` or an
agent scratchpad, usually made by another agent session that may be gone), `missing_dir`
(registered, but the folder is gone), and the `dirty` count.

## 2. Prove "merged" for each branch

Run `git fetch --prune` first, so `<remote>/<target>` is current. Sidebars and
`git branch --merged` are not evidence: both miss squash merges, and some sidebars show
"0 unpushed" for a branch that never had a remote.

Merged means one of:

- `git merge-base --is-ancestor <branch> <remote>/<target>` (merge commit or fast-forward);
- `git cherry <remote>/<target> <branch>` prints no `+` lines (rebase-merge, cherry-pick);
- `gh pr list --head <branch> --state merged --json number,headRefOid` returns a PR **and**
  the branch tip equals `headRefOid` (a squash merge, with nothing committed after it);
- or stale-check on that worktree's path says `MERGED_INTO_TARGET=yes_*` with
  `POST_MERGE_COMMITS` at 0 or n/a.

Clean means `git -C <wt> status --porcelain --untracked-files=all` prints nothing, and no stash
was made on the branch (`git stash list --format=%gs | grep -E "^(WIP on|On) <branch>:"`).
Ignored build output (`node_modules`, `.next`, `dist`) does not count. List untracked leftovers
(scripts, CSVs, notes, `.env*` files) to the user with their paths; don't remove them silently.

## 3. Stop what is running inside

```bash
lsof -nP -d cwd 2>/dev/null | grep -F "<wt-path>"    # shells, servers, agents started there
pgrep -fl "next dev|next-server|vite|webpack|tsx watch|nodemon" | grep -F "<wt-path>"
```

Stop dev servers first (`kill <pid>`). A running dev server keeps writing its cache and
recreates the folder as an empty shell right after removal. A shell or an agent session whose
working directory is inside the tree means someone may still be using it: ask.

## 4. Remove the worktree, then the branch

```bash
git -C <main-checkout> worktree remove "<wt-path>"
git -C <main-checkout> branch -d <branch>     # plain merges
git -C <main-checkout> branch -D <branch>     # squash or patch merges, only after step 2
```

- `worktree remove` refuses when the tree has modified or untracked files. Don't add `--force`
  to get past it: step 2 missed something, so go back.
- A locked worktree (`locked` in `git worktree list --porcelain`) was locked on purpose. Ask.
- `branch -d` refuses squash-merged branches as "not fully merged". Use `-D` only with a proof
  from step 2, and say which proof.
- Leave the remote branch alone unless the user asks; hosts often delete it on merge.
  `git push <remote> --delete <branch>` changes the shared remote, so confirm first.

## 5. Leftovers

- `missing_dir` registrations: `git worktree prune --dry-run -v`, then `git worktree prune`.
- Empty shells: the folder exists but has no `.git` file, only build output (`.next`,
  `node_modules`, `.turbo`). Show the user the list with what is inside each, check again that
  nothing else is there, then `rm -rf` each one.
- Local branches with no worktree whose PR merged: the same proof as step 2, then `branch -D`.

## 6. Report

Three short lists: removed (repo · branch · how the merge was proven), kept with the reason,
and needs the user's decision with the one fact they need ("3 unpushed commits, no PR ever
opened"). End with how many worktrees each repo has left.

## Gotchas

- Deleting a worktree folder with `rm -rf` instead of `git worktree remove` leaves its
  registration behind. `git worktree prune` clears it.
- The main checkout's branch can't be deleted while it is checked out. Switch the checkout to
  the target branch first, and only if it is clean.
- Stashes are repo-wide. Removing a worktree keeps them, but a stash made on a removed branch is
  unfinished work that is now easy to forget: mention it.
