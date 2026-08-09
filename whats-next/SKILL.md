---
name: whats-next
description: Re-orient the user after they return to a session and let them decide the next step by answering lightweight structured questions (Yes/No, A/B/C/D via AskUserQuestion) instead of facing a blank prompt. Trigger when the user invokes /whats-next, or asks "接下来做什么", "下一步是什么", "我该做什么", "what's next", "what should we do next", "帮我决定下一步", or returns after a long gap and wants to resume work with minimal typing. NOT for pure recap with no decision needed (that is a recap request — answer it directly or use a context-rebuild skill if available), and NOT for questions about a specific file or piece of code.
---

# What's Next

The user runs many sessions in parallel and comes back after hours away. They cannot
remember where this conversation stands. The job: rebuild the state FOR them, then hand
them a small set of concrete, clickable decisions — never a blank prompt to fill in.

Match the language of the conversation.

## Workflow

### 1. Reconstruct state (silently)

From the conversation so far, determine:

- The overall goal of this session, in one sentence.
- What is already DONE and verified (committed? deployed? approved?).
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
- **Fresh session, no meaningful context yet**: say there's nothing to resume here and
  ask what to start on — offering candidates from memory/project state if any exist.
