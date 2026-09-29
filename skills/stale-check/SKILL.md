---
name: stale-check
description: Judge whether the current repo / branch / worktree is stale — behind its target branch, already merged (incl. squash-merged via PR), merged but with commits piled on afterwards, abandoned, unpushed, or about to conflict on rebase — and say what to do about it. Read-only (only `git fetch --prune`). Trigger on /stale-check (optionally with a repo path, --target <branch>, or --all-worktrees), or when the user asks "这个分支过期了吗", "这个 repo 是不是过期了", "这个 worktree 还能用吗", "分支落后 main 多少", "这个分支合过了没", "is this branch stale", "am I behind main", "can I delete this branch/worktree", "哪些 worktree 该清了". NOT for deciding what to build next, and NOT for actually rebasing/merging/deleting — this skill only diagnoses; any fix is a separate, explicitly requested step.
license: MIT
compatibility: Needs git (>= 2.38 for the rebase-conflict probe) and bash. Uses the GitHub CLI `gh` for PR status when available.
---

# Stale Check

One question: **is this repo/branch still a valid place to keep working, or has the world moved on?**
Run the probe, map the numbers to a verdict, give the user a one-screen answer in their language.
Never rebase, merge, reset, delete, or checkout — diagnose only.

## 1. Run the probe

```bash
bash <this-skill-dir>/scripts/stale_check.sh [repo-path] [--target <branch>] [--no-fetch] [--all-worktrees]
```

- Default path is cwd. Pass a path when the user names another repo/worktree.
- Add `--all-worktrees` when the question is "which worktrees can go" or the repo has several
  worktrees (the script lists each with ahead/behind/merged/dirty/age).
- `--no-fetch` only if offline or the user says not to touch the network.
- Target branch: `--target` → `$STALE_CHECK_TARGET` → the worktree manager's own record (super.engineering's
  `sc worktree status`, used automatically inside such a session) → `origin/HEAD` → main/master. If the
  user or the tool that created the worktree says the base is something else (`develop`, a release
  branch), pass `--target`; don't re-derive it from the branch name.

The first block is `KEY=VALUE`; the rest is supporting evidence (commit lists, post-merge commits, dirty
files, other worktrees). Read the whole thing before judging.

## 2. Verdict ladder (first match wins)

| Verdict | Signals | Meaning |
| --- | --- | --- |
| **LEFTOVER — PR 合了但后面还有提交 / merged, then kept going** | `PR=MERGED` and `POST_MERGE_COMMITS` > 0 | The PR landed, then more commits went on the branch. Those commits are on no branch the target knows about. Deleting now loses them. |
| **DEAD — 已合并，可清 / merged, safe to retire** | `MERGED_INTO_TARGET=yes_*` and `DIRTY_TRACKED=0` | The branch's work already lives on target. Only untracked leftovers may still matter. |
| **REUSED — 合过的分支上又开了新活 / new work on a merged branch** | `MERGED=yes_*`, `DIRTY_TRACKED>0`, and (`AHEAD>0` or `PR=MERGED`) | The branch is finished, but uncommitted changes sit on top. They belong on a fresh branch off target. |
| **DEAD — PR 已关闭未合 / closed unmerged** | `PR=CLOSED` and `MERGED_INTO_TARGET=no` | Abandoned by decision. Ask before treating leftovers as valuable. |
| **CONFLICTING — 过期且会打架 / stale and will conflict** | `MERGED=no`, `REBASE_CONFLICT=yes` | Rebase needed and will conflict in the listed files. Cost of continuing rises daily. |
| **STALE — 明显落后 / clearly behind** | `BEHIND ≥ 30` or `MERGE_BASE_AGE_DAYS ≥ 14` or `BRANCH_TIP_AGE_DAYS ≥ 14`, none of the above | Needs a rebase before any new commit; check `OVERLAP_FILES` — overlap without conflict is still risk. |
| **DRIFTING — 稍微落后 / a little behind** | `BEHIND > 0`, none of the above | Fine to keep working; rebase before pushing / opening a PR. |
| **FRESH — 没过期 / up to date** | `BEHIND=0` (or on the target branch itself with `LOCAL_TARGET_BEHIND_REMOTE=0`) | Up to date. |

`MERGED_INTO_TARGET` values, strongest evidence first: `yes_ancestor` (fast-forward / merge commit, or the
branch has no commits of its own), `yes_patch_equivalent` (rebase-merge or cherry-pick), `yes_squash`
(the branch's whole diff equals one target commit), `yes_pr_head` (GitHub merged a PR whose head is exactly
this commit), `yes_tree_identical`. `n/a` means you are on the target branch itself.

Secondary flags to always surface when non-zero, regardless of verdict:

- `UPSTREAM=none` with `AHEAD>0` → never pushed; every branch commit exists only on this machine.
  `unpushed=?` there means "no upstream to compare with", not zero.
- `UPSTREAM state=gone` → remote branch deleted (usually post-merge). Corroborates DEAD.
- `unpushed>0`, `DIRTY_TRACKED>0`, `UNTRACKED>0` → work that would be lost if the worktree were dropped.
  List the files — the user decides.
- `AHEAD=0` → the branch has no commits of its own (`yes_ancestor` is then trivially true). With dirty
  files and no PR, it's an unstarted branch whose whole feature is still uncommitted — judge it by
  `BEHIND` and say plainly that nothing is committed yet.
- `STASHES` is repo-wide (all worktrees share it); `this_branch` counts stashes made on this branch.
  Removing a worktree does not drop stashes.
- `LOCAL_TARGET_BEHIND_REMOTE>0` when on the target branch itself → the local `main` is what's stale.
- `FETCH=failed` → every remote-derived number may be old; say so.
- `POST_MERGE_COMMITS=rewritten` → the branch was rebased/reset after its PR merged; compare the two
  commit lists by hand. `unknown` → the PR head isn't fetched locally.

Thresholds are heuristics for a repo where the target moves several commits a day. On a slow repo a
20-behind branch can be FRESH-ish; a 5-behind branch touching the same file as target can be hot. Lean on
`OVERLAP_FILES` and `REBASE_CONFLICT` over raw counts.

## 3. Report

Keep it to one screen:

1. **Verdict line** — `【DEAD / STALE / …】<branch> vs <target>`, with the 2–3 numbers that drove it.
2. **What's on target that this branch lacks** — summarize the "target commits not on this branch"
   list in one or two lines (themes, not every commit). If overlap/conflict, name the files.
3. **What would be lost** — post-merge commits, unpushed commits, dirty/untracked files. Name them.
4. **Recommended next step** — one imperative sentence, e.g. "Merged; move the 3 untracked scripts to a
   new branch or delete them, then this worktree can go" or "Before rebasing onto origin/main, look at the
   conflict in `budget-form.tsx`". Do **not** execute it. If the user then asks to rebase/delete/clean,
   that's a new request, handled under the repo's own rules and its worktree tool's own commands.

With `--all-worktrees`, add a compact table of the other worktrees (branch, ahead/behind, merged, dirty,
tip age) and mark the DEAD ones. The table only runs cheap checks; probe any borderline row on its own
(`stale_check.sh <its path>`) before calling it DEAD.

Worked examples from real runs (names and paths changed) — LEFTOVER, a squash-merged DEAD, CONFLICTING,
DRIFTING, REUSED, and a worktree sweep — are in [references/examples.md](references/examples.md). Read
them when unsure how a verdict should sound.

## Gotchas

- `PR=MERGED` alone is not "safe to delete": check `POST_MERGE_COMMITS`. People keep committing on a
  branch after the PR lands, and those commits never reach target.
- A squash merge leaves `AHEAD>0` forever. Trust `yes_squash` / `yes_pr_head` over the count;
  `git branch --merged` and most worktree sidebars report these branches as unmerged.
- `PR=none` only means no PR *from this branch name*; the work may have been re-pushed under another name
  or committed straight to target. If `MERGED=yes_*` with `PR=none`, say "content already on target, no
  PR record".
- `PR=n/a` means `gh` is missing, unauthenticated, or the remote isn't on GitHub. Merge detection still
  works from git alone, except `yes_pr_head` and `POST_MERGE_COMMITS`.
- If the user goes on to delete a worktree, a dev server still running inside it (e.g. `next dev`) can
  write its cache back and leave an empty shell directory. Worth a line in the recommendation.
- The fetch is the only network/write side effect. The script never touches local `main`; a stale local
  `main` shows up as `LOCAL_TARGET_BEHIND_REMOTE`.
