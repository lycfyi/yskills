# stale-check examples

Six runs against real repositories, with repo names, branch names, paths, commit messages, and PR
numbers replaced. The counts, ages, and verdict logic are what the probe actually reported. Probe output
is trimmed to what the verdict turned on; the commit lists are shortened.

The report language follows the question: examples 1, 3, and 5 were asked in Chinese, the rest in English.

1. [LEFTOVER: the PR merged, then the branch kept going](#1-leftover--the-pr-merged-then-the-branch-kept-going)
2. [DEAD: a two-commit squash merge](#2-dead--a-two-commit-squash-merge)
3. [CONFLICTING: three weeks and 184 commits behind](#3-conflicting--three-weeks-and-184-commits-behind)
4. [DRIFTING: behind, but a clean rebase](#4-drifting--behind-but-a-clean-rebase)
5. [REUSED: new work started on a merged branch](#5-reused--new-work-started-on-a-merged-branch)
6. [Worktree sweep: which of these can go?](#6-worktree-sweep--which-of-these-can-go)

---

## 1. LEFTOVER — the PR merged, then the branch kept going

> 这个分支能删了吧？PR 都合了。

```
REPO=/home/dev/code/acme-cli
BRANCH=feat/export-csv
FETCH=ok
TARGET=main (source=remote_head, compared_against=origin/main)
AHEAD=1
BEHIND=1
MERGE_BASE_AGE_DAYS=34
BRANCH_TIP_AGE_DAYS=15 (2026-03-05)
LOCAL_TARGET_BEHIND_REMOTE=2
UPSTREAM=origin/feat/export-csv state=present unpushed=1 unpulled=0
MERGED_INTO_TARGET=no
PR=MERGED #2 merged_at=2026-02-14T10:12:10Z https://github.com/acme/acme-cli/pull/2
POST_MERGE_COMMITS=1
DIRTY_TRACKED=0 UNTRACKED=0 STASHES=0 (this_branch=0)
REBASE_CONFLICT=clean
OVERLAP_FILES=none

## target commits not on this branch (newest 15)
c41e2b7 Merge pull request #2 from acme/feat/export-csv

## commits after PR #2 was merged
5f18a0d feat(export): never report a partial export as complete
```

**Report**

> 【LEFTOVER — PR 合了但后面还有提交】feat/export-csv vs main：PR #2 一个多月前就合了，之后又提交了 1 次，而且没推。
>
> - main 上比这个分支多的只有 PR #2 的合并提交，没有别的改动。
> - 会丢的：5f18a0d「feat(export): never report a partial export as complete」。它只在本机，远端分支和 main 上都没有。
> - 下一步：先别删。把 5f18a0d 挪到一条基于最新 main 的新分支上开 PR（rebase 不会冲突），等它合进去，这个分支再清。本地 main 落后远端 2 个提交，顺手 pull 一下。

`PR=MERGED` looks like permission to delete. The commit made after the merge only shows up in
`POST_MERGE_COMMITS`.

---

## 2. DEAD — a two-commit squash merge

> Can I delete this worktree?

```
REPO=/home/dev/.worktrees/acme-web/invoice-adjustments
BRANCH=feat/invoice-adjustments
TARGET=main (source=remote_head, compared_against=origin/main)
AHEAD=2
BEHIND=3
MERGE_BASE_AGE_DAYS=1
BRANCH_TIP_AGE_DAYS=1 (2026-03-19)
UPSTREAM=origin/feat/invoice-adjustments state=present unpushed=0 unpulled=0
MERGED_INTO_TARGET=yes_squash
PR=MERGED #141 merged_at=2026-03-19T20:16:06Z https://github.com/acme/acme-web/pull/141
POST_MERGE_COMMITS=0
DIRTY_TRACKED=0 UNTRACKED=0 STASHES=7 (this_branch=0)
REBASE_CONFLICT=n/a
OVERLAP_FILES=none

## target commits not on this branch (newest 15)
e2a91c4 fix(reports): show manual adjustments on the live leaderboard too
3fa9e61 feat(invoices): manual adjustments — entry form, CSV import, void (#141)
a18b0f2 feat(dashboard): forecast future months on the cash-flow chart

## branch commits not on target (newest 15)
1d3f9a0 feat(estimate): include adjustments in the running estimate
9c48e25 feat(invoices): manual adjustments — entry form, CSV import, void
```

**Report**

> 【DEAD — merged, safe to retire】feat/invoice-adjustments vs main: PR #141 was squash-merged yesterday
> and nothing has been committed since.
>
> - Main is 3 ahead. One of those is this branch's own squash commit (3fa9e61); the other two are
>   unrelated.
> - Nothing to lose: 0 unpushed, 0 dirty, 0 untracked. The 7 stashes were made on other branches; they
>   live in the shared repo and survive removing this worktree.
> - Next: the worktree and the branch can both go. `git branch --merged` will still call it unmerged; the
>   squash causes that, the work isn't missing.

Neither commit has a twin on main (the squash folded both into one), so `git cherry` alone would say
"unmerged". The probe matched the branch's combined diff against 3fa9e61 and got `yes_squash`. It
would have found the same without `gh`.

---

## 3. CONFLICTING — three weeks and 184 commits behind

> 这个分支还能接着做吗？

```
REPO=/home/dev/.worktrees/acme-admin/order-slots
BRANCH=feat/order-slots
TARGET=main (source=remote_head, compared_against=origin/main)
AHEAD=2
BEHIND=184
MERGE_BASE_AGE_DAYS=22
BRANCH_TIP_AGE_DAYS=22 (2026-02-26)
TARGET_TIP_AGE_DAYS=0
UPSTREAM=origin/feat/order-slots state=present unpushed=0 unpulled=0
MERGED_INTO_TARGET=no
PR=none
DIRTY_TRACKED=0 UNTRACKED=0 STASHES=4 (this_branch=0)
REBASE_CONFLICT=yes files=prisma/schema.prisma,src/components/orders/budget-form.tsx,src/lib/orders/create-order.ts,src/lib/orders/update-order.ts
OVERLAP_FILES=docs/ADMIN-API.md,package.json,prisma/schema.prisma,src/components/orders/budget-form.tsx,src/lib/orders/create-order.ts,src/lib/orders/flat-rate-projection.ts,src/lib/orders/api-tools.ts,src/lib/orders/update-order.ts,src/lib/capabilities.ts

## target commits not on this branch (newest 15)
8b1e4d2 fix(reports): leaderboard shows manual adjustments before the order locks
d94a0c7 feat(orders): audit ledger — schema + backfill
2c81f07 feat(invoices): manual adjustments admin — entry form, CSV import, void (#58)
c5d2b88 feat(orders): bundle orders — create tab, live edit, read side (#55)
60e7f1a feat(reports): export the leaderboard as CSV
…

## branch commits not on target (newest 15)
b21c9e0 feat(orders): budget form edits slots inline
6f03d4a feat(orders): slot entity — schema + admin CRUD
```

**Report**

> 【CONFLICTING — 过期且会打架】feat/order-slots vs main：落后 184 个提交，分叉 22 天，rebase 会在 4 个文件上冲突。
>
> - 这三周 main 上改得最多的是订单和发票：人工调账、新订单类型、下单流程的几轮调整。
> - 冲突在 schema.prisma、budget-form.tsx、create-order.ts、update-order.ts，正好是这个分支两个提交改的地方。另有 5 个文件两边都动过，但能自动合。
> - 不会丢东西：2 个提交都推到了远端，工作区干净。也没开过 PR。
> - 下一步：先定 slot 这件事还做不做。要做，就从最新 main 开新分支把 schema 那一步重写，比硬 rebase 两个提交省事；不做，这个分支可以连 worktree 一起清。

---

## 4. DRIFTING — behind, but a clean rebase

> Am I behind main?

```
REPO=/home/dev/.worktrees/acme-admin/vendor-payouts
BRANCH=feat/vendor-payouts
TARGET=main (source=remote_head, compared_against=origin/main)
AHEAD=11
BEHIND=6
MERGE_BASE_AGE_DAYS=3
BRANCH_TIP_AGE_DAYS=2 (2026-03-18)
UPSTREAM=origin/feat/vendor-payouts state=present unpushed=0 unpulled=0
MERGED_INTO_TARGET=no
PR=none
DIRTY_TRACKED=0 UNTRACKED=0 STASHES=4 (this_branch=0)
REBASE_CONFLICT=clean
OVERLAP_FILES=package.json,prisma/schema.prisma
```

**Report**

> 【DRIFTING — a little behind】feat/vendor-payouts vs main: 6 behind, 11 ahead, forked 3 days ago; the
> rebase comes out clean.
>
> - Main picked up the manual-adjustment feature and a couple of report fixes since you forked. Two of
>   those commits also touch `package.json` and `prisma/schema.prisma`, which this branch changes too.
>   They merge cleanly today; a schema touched on both sides is still where migration order goes wrong.
> - Nothing at risk: all 11 commits are pushed, the working tree is clean, no PR yet.
> - Next: keep working. Rebase onto origin/main before opening the PR, then check the migration order in
>   `schema.prisma`.

---

## 5. REUSED — new work started on a merged branch

> 这个 worktree 还能用吗？

```
REPO=/home/dev/code/acme-portal
BRANCH=feat/mail-provider-fallback
TARGET=main (source=remote_head, compared_against=origin/main)
AHEAD=1
BEHIND=1
MERGE_BASE_AGE_DAYS=12
BRANCH_TIP_AGE_DAYS=9 (2026-03-11)
LOCAL_TARGET_BEHIND_REMOTE=1
UPSTREAM=origin/feat/mail-provider-fallback state=gone unpushed=? unpulled=?
MERGED_INTO_TARGET=yes_patch_equivalent
PR=MERGED #2 merged_at=2026-03-11T21:43:47Z https://github.com/acme/acme-portal/pull/2
POST_MERGE_COMMITS=0
DIRTY_TRACKED=3 UNTRACKED=4 STASHES=0 (this_branch=0)
REBASE_CONFLICT=n/a
OVERLAP_FILES=none

## target commits not on this branch (newest 15)
e4f03b9 feat(mail): two providers behind one transport, with fallback (#2)

## branch commits not on target (newest 15)
a7c61de feat(mail): two providers behind one transport, with fallback

## working tree
 M next.config.mjs
 M sentry.edge.config.ts
 M sentry.server.config.ts
?? docs/DEPLOY.md
?? src/app/api/sentry-example-api/route.ts
?? src/app/global-error.tsx
?? src/app/sentry-example-page/page.tsx
```

**Report**

> 【REUSED — 合过的分支上又开了新活】feat/mail-provider-fallback vs main：分支内容已经在 main 上（PR #2），远端分支也删了，但工作区里有 3 个改动和 4 个新文件。
>
> - main 比这里多的 1 个提交，就是这个分支自己合进去的那份。
> - 会丢的：next.config.mjs 和两个 sentry.*.config.ts 的改动，外加 DEPLOY.md、global-error.tsx 和 Sentry 示例页、示例接口四个新文件。看内容是在接错误监控，跟邮件不是一件事。
> - 下一步：从最新 main 切一条新分支（比如 chore/error-monitoring），把这 7 个文件带过去。带走以后这个 worktree 就能清。本地 main 落后远端 1 个，顺手 pull。

`state=gone` plus a merged PR would read as DEAD at a glance. The seven files in the working tree are
why it isn't.

---

## 6. Worktree sweep — which of these can go?

> Which of my acme-web worktrees can I clean up?

The probe runs in the main checkout with `--all-worktrees`. The main checkout itself came back
`yes_patch_equivalent`, `PR=MERGED #136`, clean. The table:

```
## other worktrees of this repo
feat/invoice-adjustments  ahead=2 behind=3 merged=no dirty=0 tip_age_days=1  (/home/dev/.worktrees/acme-web/invoice-adjustments)
feat/estimate-breakdown  ahead=2 behind=13 merged=no dirty=0 tip_age_days=4  (/home/dev/.worktrees/acme-web/estimate-breakdown)
feat/claimed-badge  ahead=1 behind=37 merged=yes_patch dirty=0 tip_age_days=6  (/home/dev/.worktrees/acme-web/claimed-badge)
pr-97-rebase  ahead=1 behind=11 merged=yes_patch dirty=0 tip_age_days=4  (/home/dev/.worktrees/acme-web/pr-97-rebase)
feat/vendor-payouts  ahead=10 behind=7 merged=no dirty=0 tip_age_days=2  (/home/dev/.worktrees/acme-web/vendor-payouts)
```

Three rows say `merged=no`, and the table only runs `git cherry`, which misses squash merges. So each of
those three got its own probe: `invoice-adjustments` → `yes_squash`, PR #141 merged (example 2);
`estimate-breakdown` → `yes_squash`, PR #133 merged; `vendor-payouts` → `no`, no PR, rebase clean.

**Report**

> Four worktrees can go, and the main checkout can go back to `main`. `vendor-payouts` is the only live branch.
>
> | Worktree | Branch | Verdict | Why |
> | --- | --- | --- | --- |
> | main checkout | feat/rate-limit-per-source | DEAD | PR #136 merged, same patch on main |
> | invoice-adjustments | feat/invoice-adjustments | DEAD | PR #141 squash-merged |
> | estimate-breakdown | feat/estimate-breakdown | DEAD | PR #133 squash-merged |
> | claimed-badge | feat/claimed-badge | DEAD | same patch on main, 37 behind |
> | pr-97-rebase | pr-97-rebase | DEAD | content on main; no PR under this name (a rebased copy of #97) |
> | vendor-payouts | feat/vendor-payouts | DRIFTING, keep | 10 unmerged commits, clean rebase |
>
> - None of the five has dirty or untracked files. The 7 stashes are repo-wide and unaffected.
> - The main checkout is sitting on a merged feature branch; switch it back to `main` rather than
>   removing it.
> - Next: remove the four DEAD worktrees and their branches, and stop any dev server running in them
>   first. Nothing has been deleted yet.
