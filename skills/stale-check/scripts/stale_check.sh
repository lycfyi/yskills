#!/usr/bin/env bash
# stale_check.sh — read-only staleness probe for the current repo/branch.
#
# Usage: stale_check.sh [repo-path] [--target <branch>] [--no-fetch] [--all-worktrees]
#
# Never mutates anything except `git fetch --prune` on the remote-tracking refs
# (skipped with --no-fetch). Prints a KEY=VALUE block first (machine-readable),
# then human-readable sections.
#
# Target branch, first hit wins:
#   --target <branch> → $STALE_CHECK_TARGET → super.engineering's `sc worktree status`
#   (only inside a super.engineering session) → <remote>/HEAD → main → master
#
# Needs git >= 2.38 for the rebase-conflict probe (older git reports REBASE_CONFLICT=unknown).
# Uses `gh` for PR status when it is installed and authenticated; otherwise PR=n/a.

set -u

REPO="."
FETCH=1
ALL_WT=0
TARGET="${STALE_CHECK_TARGET:-}"
TARGET_SOURCE=""
[ -n "$TARGET" ] && TARGET_SOURCE=env
while [ $# -gt 0 ]; do
  case "$1" in
    --no-fetch) FETCH=0 ;;
    --all-worktrees) ALL_WT=1 ;;
    --target) TARGET="${2:-}"; TARGET_SOURCE=flag; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) REPO="$1" ;;
  esac
  shift
done

cd "$REPO" 2>/dev/null || { echo "ERROR=not a directory: $REPO"; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "ERROR=not a git repo: $REPO"; exit 2; }
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT" || exit 2
git rev-parse -q --verify HEAD >/dev/null 2>&1 || { echo "REPO=$ROOT"; echo "ERROR=no commits yet (unborn HEAD)"; exit 2; }

now=$(date +%s)
days_ago() { # $1 = epoch
  [ -z "${1:-}" ] && { echo "?"; return; }
  echo $(( (now - $1) / 86400 ))
}

# ---------- remote ----------
if git remote | grep -qx origin; then REMOTE=origin; else REMOTE=$(git remote | head -1); fi
FETCH_STATUS=skipped
if [ "$FETCH" = 1 ] && [ -n "$REMOTE" ]; then
  if git fetch --prune --quiet "$REMOTE" 2>/dev/null; then FETCH_STATUS=ok; else FETCH_STATUS=failed; fi
fi

# ---------- branch & target ----------
BRANCH=$(git symbolic-ref -q --short HEAD 2>/dev/null)
DETACHED=0
[ -z "$BRANCH" ] && { BRANCH="(detached)"; DETACHED=1; }
HEAD_SHA=$(git rev-parse --short HEAD)

# A worktree manager that owns the target branch beats any guess from git. `sc` answers
# for the session's own worktree only, so skip it when probing some other path.
SESSION_WT="${SUPER_ENGINEERING_WORKTREE_PATH:-${SUPERCONDUCTOR_WORKTREE_PATH:-}}"
if [ -z "$TARGET" ] && [ -n "$SESSION_WT" ] && command -v sc >/dev/null 2>&1 \
   && [ "$(cd "$SESSION_WT" 2>/dev/null && pwd -P)" = "$(pwd -P)" ]; then
  TARGET=$(sc worktree status --json </dev/null 2>/dev/null | sed -n 's/.*"target_branch": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$TARGET" ] && TARGET_SOURCE=sc
fi
if [ -z "$TARGET" ] && [ -n "$REMOTE" ]; then
  TARGET=$(git symbolic-ref -q --short "refs/remotes/$REMOTE/HEAD" 2>/dev/null | sed "s#^$REMOTE/##")
  [ -n "$TARGET" ] && TARGET_SOURCE=remote_head
fi
if [ -z "$TARGET" ]; then
  for c in main master; do
    if git show-ref -q --verify "refs/heads/$c" || git show-ref -q --verify "refs/remotes/$REMOTE/$c"; then TARGET=$c; TARGET_SOURCE=guess; break; fi
  done
fi

# resolve the target ref to compare against: prefer remote copy (fresher than local main)
if [ -n "$REMOTE" ] && git show-ref -q --verify "refs/remotes/$REMOTE/$TARGET"; then
  TARGET_REF="$REMOTE/$TARGET"
else
  TARGET_REF="$TARGET"
fi
ON_TARGET=0
[ "$BRANCH" = "$TARGET" ] && ON_TARGET=1

# ---------- ahead / behind vs target ----------
AHEAD=""; BEHIND=""; MB=""; MB_DAYS=""
if [ -n "$TARGET_REF" ] && git rev-parse -q --verify "$TARGET_REF" >/dev/null 2>&1; then
  read -r BEHIND AHEAD <<<"$(git rev-list --left-right --count "$TARGET_REF...HEAD" 2>/dev/null)"
  MB=$(git merge-base "$TARGET_REF" HEAD 2>/dev/null)
  if [ -n "$MB" ]; then
    MB_DAYS=$(days_ago "$(git log -1 --format=%ct "$MB")")
  fi
fi

# local target vs remote target (is my local main itself stale?)
LOCAL_TARGET_BEHIND=""
if [ -n "$REMOTE" ] && git show-ref -q --verify "refs/heads/$TARGET" && git show-ref -q --verify "refs/remotes/$REMOTE/$TARGET"; then
  LOCAL_TARGET_BEHIND=$(git rev-list --count "$TARGET..$REMOTE/$TARGET" 2>/dev/null)
fi

# ---------- upstream tracking ----------
UPSTREAM=""; UPSTREAM_STATE=none; UP_AHEAD=""; UP_BEHIND=""
if [ "$DETACHED" = 0 ]; then
  UPSTREAM=$(git for-each-ref --format='%(upstream:short)' "refs/heads/$BRANCH" 2>/dev/null)
  if [ -n "$UPSTREAM" ]; then
    if git rev-parse -q --verify "$UPSTREAM" >/dev/null 2>&1; then
      UPSTREAM_STATE=present
      read -r UP_BEHIND UP_AHEAD <<<"$(git rev-list --left-right --count "$UPSTREAM...HEAD" 2>/dev/null)"
    else
      UPSTREAM_STATE=gone   # remote branch deleted (typically after merge)
    fi
  fi
fi

# ---------- last activity ----------
TIP_DAYS=$(days_ago "$(git log -1 --format=%ct HEAD)")
TIP_DATE=$(git log -1 --format=%cs HEAD)
TARGET_TIP_DAYS=""
if [ -n "$MB" ]; then
  TARGET_TIP_DAYS=$(days_ago "$(git log -1 --format=%ct "$TARGET_REF")")
fi

# ---------- PR status ----------
PR_STATE=""; PR_NUMBER=""; PR_URL=""; PR_MERGED_AT=""; PR_HEAD=""
if command -v gh >/dev/null 2>&1 && [ "$ON_TARGET" = 0 ] && [ "$DETACHED" = 0 ]; then
  pr=$(gh pr list --head "$BRANCH" --state all --limit 1 --json number,state,url,mergedAt,headRefOid 2>/dev/null)
  if [ -n "$pr" ] && [ "$pr" != "[]" ]; then
    PR_NUMBER=$(echo "$pr" | sed -n 's/.*"number":\([0-9]*\).*/\1/p')
    PR_STATE=$(echo "$pr" | sed -n 's/.*"state":"\([A-Z]*\)".*/\1/p')
    PR_URL=$(echo "$pr" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
    PR_MERGED_AT=$(echo "$pr" | sed -n 's/.*"mergedAt":"\([^"]*\)".*/\1/p')
    PR_HEAD=$(echo "$pr" | sed -n 's/.*"headRefOid":"\([0-9a-f]*\)".*/\1/p')
  elif [ -n "$pr" ]; then
    PR_STATE=none
  fi
fi

# Commits made on the branch after its PR was merged. They exist on no branch the
# target knows about, so "the PR is merged" does not mean "safe to delete".
POST_MERGE=""
if [ "$PR_STATE" = MERGED ] && [ -n "$PR_HEAD" ]; then
  if ! git cat-file -e "$PR_HEAD^{commit}" 2>/dev/null; then
    POST_MERGE=unknown          # PR head not fetched locally
  elif git merge-base --is-ancestor "$PR_HEAD" HEAD 2>/dev/null; then
    POST_MERGE=$(git rev-list --count "$PR_HEAD..HEAD")
  else
    POST_MERGE=rewritten        # branch was rebased/reset after the merge
  fi
fi

# ---------- merged? ----------
# yes_ancestor          every branch commit is reachable from target (ff / merge commit, or AHEAD=0)
# yes_patch_equivalent  each branch commit has a same-patch twin on target (rebase-merge, cherry-pick)
# yes_squash            the branch's whole diff matches one target commit (squash of N commits)
# yes_pr_head           GitHub merged a PR whose head is exactly this commit (squash that no longer diffs cleanly)
# yes_tree_identical    branch tree == target tree
MERGED=no
if [ "$ON_TARGET" = 1 ]; then
  MERGED=n/a
elif [ -n "$MB" ]; then
  if git merge-base --is-ancestor HEAD "$TARGET_REF" 2>/dev/null; then
    MERGED=yes_ancestor
  else
    plus=$(git cherry "$TARGET_REF" HEAD 2>/dev/null | grep -c '^+' || true)
    [ "$plus" = 0 ] && MERGED=yes_patch_equivalent
    if [ "$MERGED" = no ] && [ "${AHEAD:-0}" -gt 1 ] && [ "${BEHIND:-0}" -le 2000 ]; then
      branch_pid=$(git diff "$MB" HEAD | git patch-id --stable 2>/dev/null | awk '{print $1}')
      if [ -n "$branch_pid" ] && git log -p --no-merges "$MB..$TARGET_REF" 2>/dev/null \
           | git patch-id --stable 2>/dev/null | awk '{print $1}' | grep -qx "$branch_pid"; then
        MERGED=yes_squash
      fi
    fi
    if [ "$MERGED" = no ] && [ "$POST_MERGE" = 0 ]; then MERGED=yes_pr_head; fi
    if [ "$MERGED" = no ] && [ -z "$(git diff --stat "$TARGET_REF" HEAD 2>/dev/null)" ]; then MERGED=yes_tree_identical; fi
  fi
fi

# ---------- working tree ----------
DIRTY=$(git status --porcelain --untracked-files=all 2>/dev/null | grep -vc '^??' || true)
UNTRACKED=$(git status --porcelain --untracked-files=all 2>/dev/null | grep -c '^??' || true)
# Stashes live in the shared repo, not in a worktree: removing a worktree never loses them.
STASHES=$(git stash list 2>/dev/null | wc -l | tr -d ' ')
STASHES_BRANCH=0
if [ "$DETACHED" = 0 ] && [ "$STASHES" != 0 ]; then
  STASHES_BRANCH=$(git stash list --format=%gs 2>/dev/null | grep -cE "^(WIP on|On) $BRANCH:" || true)
fi

# ---------- conflict probe (read-only; git >= 2.38) ----------
CONFLICT=""; CONFLICT_FILES=""
if [ -n "$MB" ] && [ "${BEHIND:-0}" -gt 0 ] && [ "${AHEAD:-0}" -gt 0 ] && [ "$MERGED" = no ]; then
  out=$(git merge-tree --write-tree --name-only "$TARGET_REF" HEAD 2>/dev/null)
  rc=$?
  if [ $rc -eq 0 ]; then CONFLICT=clean
  elif [ $rc -eq 1 ]; then
    CONFLICT=yes
    # output: tree OID, conflicted paths, blank line, informational messages → keep only the path block
    CONFLICT_FILES=$(echo "$out" | sed '1d' | sed '/^$/q' | sed '/^$/d' | sort -u | tr '\n' ',' | sed 's/,$//')
  else CONFLICT=unknown; fi
fi

# ---------- overlap: files touched by both sides since merge-base ----------
OVERLAP=""
if [ -n "$MB" ] && [ "${BEHIND:-0}" -gt 0 ] && [ "${AHEAD:-0}" -gt 0 ] && [ "${MERGED#yes}" = "$MERGED" ]; then
  OVERLAP=$(comm -12 <(git diff --name-only "$MB" HEAD | sort) <(git diff --name-only "$MB" "$TARGET_REF" | sort) | tr '\n' ',' | sed 's/,$//')
fi

# ---------- print ----------
echo "REPO=$ROOT"
echo "BRANCH=$BRANCH"
echo "HEAD=$HEAD_SHA"
echo "FETCH=$FETCH_STATUS"
echo "TARGET=${TARGET:-?} (source=${TARGET_SOURCE:-none}, compared_against=${TARGET_REF:-?})"
echo "AHEAD=${AHEAD:-?}"
echo "BEHIND=${BEHIND:-?}"
echo "MERGE_BASE_AGE_DAYS=${MB_DAYS:-?}"
echo "BRANCH_TIP_AGE_DAYS=$TIP_DAYS ($TIP_DATE)"
echo "TARGET_TIP_AGE_DAYS=${TARGET_TIP_DAYS:-?}"
echo "LOCAL_TARGET_BEHIND_REMOTE=${LOCAL_TARGET_BEHIND:-n/a}"
echo "UPSTREAM=${UPSTREAM:-none} state=$UPSTREAM_STATE unpushed=${UP_AHEAD:-?} unpulled=${UP_BEHIND:-?}"
echo "MERGED_INTO_TARGET=$MERGED"
echo "PR=${PR_STATE:-n/a}${PR_NUMBER:+ #$PR_NUMBER}${PR_MERGED_AT:+ merged_at=$PR_MERGED_AT}${PR_URL:+ $PR_URL}"
echo "POST_MERGE_COMMITS=${POST_MERGE:-n/a}"
echo "DIRTY_TRACKED=$DIRTY UNTRACKED=$UNTRACKED STASHES=$STASHES (this_branch=$STASHES_BRANCH)"
echo "REBASE_CONFLICT=${CONFLICT:-n/a}${CONFLICT_FILES:+ files=$CONFLICT_FILES}"
echo "OVERLAP_FILES=${OVERLAP:-none}"

if [ -n "$MB" ]; then
  echo
  echo "## target commits not on this branch (newest 15)"
  git log --oneline --no-decorate -15 "HEAD..$TARGET_REF" 2>/dev/null
  echo
  echo "## branch commits not on target (newest 15)"
  git log --oneline --no-decorate -15 "$TARGET_REF..HEAD" 2>/dev/null
fi
if [ -n "$POST_MERGE" ] && [ "$POST_MERGE" != 0 ] && [ "$POST_MERGE" != unknown ] && [ "$POST_MERGE" != rewritten ]; then
  echo
  echo "## commits after PR #$PR_NUMBER was merged"
  git log --oneline --no-decorate "$PR_HEAD..HEAD"
fi
if [ "$DIRTY" != 0 ] || [ "$UNTRACKED" != 0 ]; then
  echo
  echo "## working tree"
  git status --short --untracked-files=all | head -40
fi

if [ "$ALL_WT" = 1 ]; then
  echo
  echo "## other worktrees of this repo"
  git worktree list --porcelain | awk '
    /^worktree /{sub(/^worktree /,""); w=$0; b="(detached)"}
    /^branch /{sub(/^branch refs\/heads\//,""); b=$0}
    /^$/{if (w!="") print b "\t" w; w=""}
    END{if (w!="") print b "\t" w}' | while IFS="$(printf '\t')" read -r br wt; do
    [ "$wt" = "$ROOT" ] && continue
    ref="$br"; [ "$br" = "(detached)" ] && ref=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
    dirty=$(git -C "$wt" status --porcelain --untracked-files=all 2>/dev/null | wc -l | tr -d ' ')
    if [ -n "$MB" ]; then
      read -r b a <<<"$(git rev-list --left-right --count "$TARGET_REF...$ref" 2>/dev/null)"
      merged=no
      if git merge-base --is-ancestor "$ref" "$TARGET_REF" 2>/dev/null; then merged=yes
      elif [ "$(git cherry "$TARGET_REF" "$ref" 2>/dev/null | grep -c '^+' || true)" = 0 ]; then merged=yes_patch
      fi
      age=$(days_ago "$(git log -1 --format=%ct "$ref" 2>/dev/null)")
      echo "$br  ahead=$a behind=$b merged=$merged dirty=$dirty tip_age_days=$age  ($wt)"
    else
      echo "$br  dirty=$dirty  ($wt)"
    fi
  done
fi
