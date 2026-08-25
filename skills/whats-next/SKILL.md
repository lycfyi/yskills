---
name: whats-next
description: >-
  Re-orient the user after they return to a session — or after they open a FRESH
  context pointed at a worktree/branch — and let them decide the next step by
  answering lightweight structured questions (Yes/No, A/B/C/D via
  AskUserQuestion) instead of facing a blank prompt. Trigger when the user invokes
  /whats-next (optionally naming a worktree, branch, or repo path), or asks
  "接下来做什么", "下一步是什么", "我该做什么", "这个 worktree/分支做到哪了、下一步呢",
  "what's next", "what should we do next", "帮我决定下一步", or returns after a
  long gap and wants to resume work with minimal typing. Works with zero
  conversation history: state is then rebuilt from git evidence (diffs, branch
  commits, uncommitted changes) and handoff/task docs. NOT for pure recap with no
  decision needed (that is a recap request — answer it directly or use a
  context-rebuild skill if available), and NOT for questions about a specific
  file or piece of code.
license: MIT
---

# What's Next

The user runs many sessions in parallel and comes back after hours away. They cannot
remember where this conversation stands. The job: rebuild the state FOR them, then hand
them a small set of concrete, clickable decisions — never a blank prompt to fill in.

Match the language of the conversation.

## Workflow

### 0. Pick the evidence source

Two invocation shapes, same downstream flow:

- **Warm session** — there is real conversation history: the conversation IS the record.
  Go straight to step 1.
- **Cold start / named target** — a fresh context, or the user points at a worktree,
  branch, or repo path ("这个 worktree 的 diffs", "新分支做到哪了"). There is no
  conversation to mine; rebuild state from repo evidence instead:
  - Resolve the target first. If ambiguous, `git worktree list` / branch list. Don't
    infer the base/target branch from branch names alone — check the remote HEAD or
    whatever tool of record the setup has. One clarifying question max.
  - Read, in rough priority order: uncommitted changes (`git status` + diff of the
    working tree), branch commits not on the base branch (`git log base..HEAD`
    with `--stat`), the actual diff vs. base when commit messages aren't enough, any
    task/handoff doc that scopes this work (a handoff doc in the repo, the PR
    description, an issue-tracker ticket named in commits), and recent-commit
    trailers that record acceptance/deploy state.
  - The mapping: committed-and-merged → DONE; committed on branch but not merged →
    done-but-not-landed; uncommitted diff → in flight; task-doc items with no
    corresponding diff → planned, not started. A step described in a doc with no code
    evidence did NOT happen.
  - Don't read every file end-to-end — read enough to name the milestones and the
    fork points, and say when a judgment rests on commit messages alone.

### 1. Reconstruct state (silently)

From the evidence source chosen above, determine:

- The overall goal of this session, in one sentence.
- What is already DONE and verified (committed? deployed? approved?). A big code or
  rule change that is deployed but not yet manually verified by the user is NOT done —
  classify it as awaiting-manual-verification, a state of its own.
- What is IN FLIGHT: background agents, workflows, deploys, external waits. Never
  fabricate a result for anything still running — report it as pending.
- What is BLOCKED and on what — especially things blocked on the user's own decision.
- What was PLANNED but not started.

Trust the conversation record over memory of intent: if a step was described but no tool
call shows it happened, it did not happen.

### 2. Brief recap first (3–5 lines, no more)

Before asking anything, print a tight orientation so the choices make sense:

- **First line, always: the close-session verdict.** State plainly whether this session
  can be closed right now — "✅ 可以关：没有在跑的任务，成果都已落盘" or
  "⚠️ 先别关：XX 还在跑 / XX 只存在于这个对话里还没写进文件"。Judge it by:
  - Anything still running (background agents, workflows, deploys being watched)?
  - Any work product that exists ONLY in this conversation — not yet written to a file,
    committed, or recorded anywhere durable?
  - Any pending step that needs THIS session's context to finish, vs. one a fresh
    session could pick up from files/handoff docs alone?
  If closing loses nothing, say so explicitly — permission to close is the answer the
  user most often needs. If not closable, name the single cheapest action that would
  make it closable (e.g. "把结论写进 handoff 文档就能关").
- One line: what this session is about.
- One line: last completed milestone.
- One line each: anything in flight or blocked.
- **Standard SOP — post-deploy manual test.** If the state includes a bigger code or
  rule change that was deployed but not yet manually verified, attach a quick manual
  test recipe right in the recap: 3–5 steps — which page/entry point (with URL), what
  account or data to use, what to do, what the expected result looks like, and what
  result would mean it's broken. One of the AskUserQuestion options should then be
  "walk through this manual test" (usually the recommended one). Deployed-but-unverified
  also weighs into the close-session verdict — it's the classic "don't close yet" reason.

Plain prose, outcome-first, no headers, no internal codenames or table names. The recap
exists only so the user can answer the questions confidently — details they don't need
for the decision stay out.

### 3. Identify the REAL fork points

List the decisions that actually determine what happens next. Good fork points:

- "Deploy now vs. run acceptance first"
- "Continue feature X vs. switch to the bug that surfaced"
- "Commit what's staged vs. review the diff together"
- "The blocked item: resolve it via A or drop it"

Not fork points (never ask these):

- Anything with an obvious conventional answer — just do it.
- Anything already decided earlier in the conversation — don't re-litigate.
- Fake choices where every option means "continue" — collapse them.
- Permission-seeking for reversible work that follows from the original request.

### 4. Ask via AskUserQuestion

One single AskUserQuestion call, 1–3 questions max, batched together. Rules for options:

- 2–4 options, each a concrete action phrased so that clicking it is sufficient — the
  user should never need to type a follow-up for the option to be executable.
  Write "部署到 staging 并跑一遍验收" not "继续部署相关工作".
- Put the recommended option FIRST with "(Recommended)" appended, and say in the
  description why it's recommended.
- Include the do-nothing/defer option when it's genuinely reasonable ("先放着，处理别的").
- When the session is NOT closable, one option should usually be the cheapest path to
  making it closable ("把结论落进 handoff 文档，然后这个 session 就能关了") — the user
  often wants to shut sessions down, not extend them.
- Use multiSelect when items are independent tasks the user might want several of.
- Sequence matters: if question 2 only makes sense under one answer to question 1,
  ask only question 1 now and follow up after.

### 5. Act immediately

After the user answers, execute the chosen option without re-confirming. The whole point
is that one click resumes the work. If the chosen path later hits a genuine new fork,
ask again — same lightweight format.

## Edge cases

- **Nothing pending, task complete**: say so in two lines, then ask one question offering
  plausible follow-ups (including "结束，没别的了").
- **Everything blocked on external waits**: report what is being waited on and expected
  timing; ask whether to poll now, switch to other work (offer specific candidates), or
  leave it.
- **The real next step needs substantive user input** (e.g. wording only they can write,
  a business judgment with no good default): don't force fake options. Ask the one
  open question directly and say why it can't be optioned.
- **Fresh session, no meaningful context, and no target named**: say there's nothing to
  resume here and ask what to start on — offering candidates from memory/project state
  if any exist. (If a worktree/branch WAS named, that's a cold start — go through
  step 0, not this case.)
- **Cold start on a worktree**: the close-session verdict becomes a close-WORKTREE
  verdict — can this worktree be wrapped up (merged/PR'd/deleted)? Judge by: uncommitted
  work present? branch merged to its target? task-doc acceptance recorded? Offer the
  cheapest path to closable ("把这两个未提交文件 commit 掉就能开 PR") as an option.
