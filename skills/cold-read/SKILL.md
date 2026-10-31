---
name: cold-read
description: >-
  Cold-read user-facing words the way a first-time, lazy, hurried reader would, using
  fresh-context reader subagents that never saw the conversation that produced them:
  UI copy (a strings-file diff, screenshots, or a who/where/text list), landing pages,
  profile bios, decks and charts, plans, emails, notifications, application answers,
  and the options an agent is about to show a human. Finds text that should
  not be on the page (implementation talk, design rationale, restated requirements,
  placeholders) and text that will be misread (unclear who decides, buttons that hide the
  consequence, raw codes, undefined groups, numbers without a unit, one thing with two
  names). Returns numbered findings to triage by number. Trigger: "cold read
  this", "冷读", "冷读一下", "would a new user get this", "read this as a CTO / an
  investor / a busy owner", "压测一下文案", before handing back or merging any change to
  user-visible text, and before sending a deck, bio or application. NOT for translation
  accuracy, grammar, or visual layout.
license: MIT
compatibility: Works best in agents that can start fresh-context subagents (Claude Code's Agent tool, Codex sub-sessions). Without them, open a new session per reader.
---

# Cold read

The author cannot unsee what they meant. Neither can the agent that wrote the change: it
read the requirements, the discussion and the design rationale, so every sentence on the
page looks obvious to it. A cold read hands the words to readers who have none of that
context and asks what they *think* the page says and what they would do next. The gap
between that and what is true is the finding.

Run it without being asked whenever a change touches words a user will see, before you
hand the change back or merge it. Run it before a deck, bio, landing page or application
goes out. It costs a few subagent calls; a misread on a live page costs much more.

## 1. Collect the input — and keep the context out

Give readers only what the real reader would have:

- **UI copy:** a git range (`origin/main...HEAD`) so the reviewer diffs the strings files
  itself (`messages/*.json`, `locales/**`, `*.strings`, `*.po` — whatever the repo uses);
  or screenshots; or a list with one row per string: who sees it, where they are and what
  they want to do, the text on screen.
- **Pages and documents:** the rendered text or screenshots, in the order a reader meets them.
- **What each button actually does** (who gets notified, whether it is instant, whether it
  can be undone). Give this to the rubric reviewer, not to personas. It lets the reviewer
  compare the lazy reading with the truth.

Never pass the chat history, the ticket, the design rationale or your own summary of
intent. If the reader needs it to understand the page, the page is the problem.

## 2. Choose the readers

| Reader | When | Model |
|---|---|---|
| **Rubric reviewer** — the two-pass rubric in `references/rubric.md` | Always | Strongest available |
| **Personas** — 2–4 cards from `references/personas.md`, matched to the real audience | Public pages, onboarding, bios, decks, applications, plans other roles must act on | Strong model; a fast model only for evidence (below) |
| **Lazy first pass** — `exam/lazy-read-prompt.md` | Many screens at once, or you want raw "I assumed…" notes | Fast/cheap model, evidence only |

A fast model playing the newcomer is good at producing raw confusion ("I thought this
button sends it now"). It is bad at judging. On the bundled exam, a fast model reading and
judging alone caught 12 of the 21 problems in set A. The strongest model with this rubric
caught 20 of 21 in set A and 12 of 13 in the held-out set B, with no false alarms (one run
per set; details in `exam/README.md`). So a cheap reader writes notes, and the strong
reviewer decides.

Each reader is its own fresh-context subagent. Start them in parallel.

## 3. Brief each reader

Rubric reviewer:

```
You are cold-reading user-facing text. Follow the rubric in <path>/references/rubric.md
exactly. Input: <git range | screenshot paths | the who/where/text list>.
What each button actually does: <list, or "not given">.
House rules, if any: <path to VOICE.md / COPY.md / glossary, or "none">.
Report only; do not edit files. End with the TOTAL and FLAGGED lines.
```

Persona reader:

```
<persona card from references/personas.md>
Here is what you are looking at: <artifact>. You have never seen this product before.
Read it the way you really would. Then answer:
1. In one sentence: what is this, and who is it for?
2. What do you think happens if you take the main action? Who decides, who waits?
3. Where did you stop reading, and why?
4. Words, numbers or codes you did not understand, and what you guessed they meant.
5. What would you do next: act, ask, or leave?
Quote the exact text behind every point. Don't invent problems to have something to say.
```

## 4. Merge and hand over

1. Put every finding under the exact quoted text. Merge duplicates and note which readers
   hit it. A misread that several readers share comes first.
2. For each: verdict (**delete** / **rewrite →** "…" / **keep**), the reason, and the
   misreading in the reader's words ("they thought…").
3. Number the list. The human triages by number ("1 fix, 2 skip, 3 your call"). Don't ask
   them to reread the page.
4. "No problems found" is a valid result. Padding the list teaches people to ignore it.
5. After fixes, cold-read only the changed text again, with new readers.

Things you found that are outside the change (old copy, another page) go in a separate
short list. Don't silently widen the change.

## 5. House rules

If the repo has a voice guide, copy guide or glossary (`VOICE.md`, `COPY.md`,
`docs/glossary*`, `.cold-read/house-rules.md`), the reviewer reads it first, and it wins
where it conflicts with the rubric. Product-specific rules ("always say who reviews",
banned words, the name of each feature) belong there, not in the rubric.

## 6. Calibrate before you change the rubric

`exam/` holds two answer-keyed sets of copy: A for tuning, B held out. Run both before and
after editing `references/rubric.md`, with fresh reviewers that see only the exam and the
rubric, and score with `exam/score.py`. The scores must not drop. When real users or
simulations show a new kind of misread, add it to set A. See `exam/README.md`.
