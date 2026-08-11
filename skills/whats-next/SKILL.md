---
name: whats-next
description: >-
  Re-orient the user after they return to a session — or after they open a FRESH
  context pointed at a worktree/branch — and let them decide the next step by
  answering lightweight questions through the host's structured-question tool
  (Yes/No, A/B/C/D) instead of facing a blank prompt. Trigger when the user invokes
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

- **Warm session** — there is real conversation history: use it as the record of intent
  and narrative, but cheaply check repo reality before step 1: inspect the current branch
  and working-tree status/diff. This catches changes made in an IDE, terminal, or another
  session without turning the warm path into a full cold-start reconstruction.
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
    done-but-not-landed; task-doc items with no corresponding diff → planned, not
    started. Classify uncommitted changes by attribution and verification: determine
    whether they belong to the target work, then whether they are verified, finished
    work awaiting commit, an experiment, or unrelated scratch material. A dirty tree by
    itself is not proof that the target work is in flight or that the worktree cannot
    close. A step described in a doc with no code evidence is only a claim, not proof.
  - Don't read every file end-to-end — read enough to name the milestones and the
    fork points, and say when a judgment rests on commit messages alone.

### 1. Reconstruct state (silently)

From the evidence source chosen above, determine:

- The overall goal of this session, in one sentence.
- What is already DONE and verified (committed? deployed? approved?).
- What is IN FLIGHT: background agents, workflows, deploys, external waits. Query the
  host or external system for their current state before any close-session verdict;
  never fabricate a result for anything still running — report it as pending. If the
  state cannot be queried, mark it unverified and do not emit a safe-to-close verdict.
- What is BLOCKED and on what — especially things blocked on the user's own decision.
- What was PLANNED but not started.

Grade evidence instead of flattening it: a directly observed tool result is strongest,
followed by a commit or file on disk, current external-system state, and an explicit user
statement. For an action the assistant claims to have performed, no corresponding tool
result means it is unverified — not completed. Do not apply that rule to work performed
by the user, CI, a deploy pipeline, or an external agent; report it at the evidence grade
actually available.

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
  A safe-to-close verdict requires the runtime/in-flight check from step 1. If that state
  cannot be queried, say it is unverified and do not claim the session is safe to close.
  If closing loses nothing, say so explicitly — permission to close is the answer the
  user most often needs. If not closable, name the single cheapest action that would
  make it closable (e.g. "把结论写进 handoff 文档就能关").
- One line: what this session is about.
- One line: last completed milestone.
- One line each: anything in flight or blocked that bears on the upcoming decision. If
  in-flight and blocked items would push the recap past five lines, collapse the rest
  into one count such as "另有 N 项在跑"; put their details in the option descriptions
  instead.

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

### 4. Optional external context layer (enrich, never invent)

Only run this when step 3 already produced a real fork whose options or recommendation
could change with better evidence — this layer refines existing forks, it never generates
a new one. Skip it when no surfaced fork would change; not every session needs external
signal.

Sources, each optional and independently unavailable:

- **GitHub PR / CI** — review state, approval, checks passing/failing, merge status.
- **Connected issue tracker** — ticket status, whether a declared blocker is resolved.
- **Running external work** — the actual current state of an agent, workflow, or deploy
  the session is watching (not the session's memory of having started it).

Only pull a source that maps directly onto an existing fork (e.g. a "commit vs. review
together" fork looks up PR/CI state; a "continue vs. switch to unblocked item" fork looks
up the tracker). If a source is unreachable or errors, mark it "外部证据未取得" when
presenting options and fall back to local evidence — never treat a failed query as
absence of the thing being checked. External findings can re-order or eliminate an
existing fork's options; they never add a fork that step 3 didn't already surface, and
they never override a close-session verdict already established from local,
directly-observed evidence.

### 5. Ask through the host's structured-question tool

Use one batched call to the host's structured-question tool, with 1–3 questions max. It
must support a marked recommended option and, when needed, optional multi-select. Rules
for options:

- 2–4 options, each a concrete action phrased so that clicking it is sufficient — the
  user should never need to type a follow-up for the option to be executable.
  Write "部署到 staging 并跑一遍验收" not "继续部署相关工作".
- Put the recommended option FIRST and mark it through structured metadata; keep its
  label to the action alone, and say in the description why it's recommended.
- Include the do-nothing/defer option when it's genuinely reasonable ("先放着，处理别的").
- When the session is NOT closable, one option should usually be the cheapest path to
  making it closable ("把结论落进 handoff 文档，然后这个 session 就能关了") — the user
  often wants to shut sessions down, not extend them.
- Enable the tool's optional multi-select capability when items are independent tasks
  the user might want several of.
- Sequence matters: if question 2 only makes sense under one answer to question 1,
  ask only question 1 now and follow up after.

### 6. Act immediately

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
  verdict — can this worktree be wrapped up (merged/PR'd/deleted)? Judge by: do
  uncommitted changes belong to the target work and remain unverified or unfinished? is
  the branch merged to its target? is task-doc acceptance recorded? Offer the cheapest
  path to closable ("把这两个未提交文件 commit 掉就能开 PR") as an option.
