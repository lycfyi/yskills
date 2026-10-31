# Cold-read calibration exam

Two answer-keyed sets of in-app copy. They measure how much a cold-read reviewer actually catches. Sit both sets before and after you change the reviewer's rules; the scores should not go down.

## The two sets

| Set | Exam | Items | With a problem | Fine | Key | Use |
|---|---|---|---|---|---|---|
| A | `exam-a.md` | 27 | 21 | 6 | `key-a.json` | Tuning: rules and examples may come from it |
| B | `exam-b.md` | 18 | 13 | 5 | `key-b.json` | **Held out**: checking only |

Set B is never used to tune the reviewer's rules. It only checks them, so you can tell whether the rules generalize or have just memorized set A. Don't quote set B items in the rubric.

Every item is adapted from a real misread observed in user simulations of a production app. A simulated first-time user (lazy, hurried, on a phone) misread the copy, couldn't tell who decides or what a button does, or never tapped it. The fine items are wordings the same simulations showed people understood, or the fixed versions of earlier problems. The text has been moved into five fictional products: a team expense tool, an online course platform, a coworking desk-booking app, a print-on-demand shop and a recipe-box subscription. Each item keeps its failure mode (or the reason it reads fine) and its difficulty.

## How to run

1. Spawn one fresh-context reviewer per set. Give it only the exam file and the rubric (`../references/rubric.md`). Don't give it the key, this README, or what the buttons actually do.
2. The reviewer ends with a line like `FLAGGED: 1, 2, 4`. Pass the numbers to the scorer:

   ```bash
   python3 score.py a "1,2,4,5,6"
   python3 score.py b "1,2,4"
   ```

   It prints how many problem items were caught, how many fine items were flagged, and the key's reason for each miss and each false positive.
3. Read every miss and every false positive. A false positive with a sound reason (for example, "replace the ID with a name") gets a note; it is not a regression.

`lazy-read-prompt.md` is an optional first pass. A model plays the first-time user and writes, for each item, what it assumed from the first line and the buttons alone. Give those notes to the reviewer as evidence; don't score them as the verdict.

## Adding items

When a simulation, a usability test or a support ticket shows a new copy problem, add the on-screen text to set A and the misread to `key-a.json`, then run both sets again. The keys look like `{"bad": {"<n>": "<the misread>"}, "good": {"<n>": "<why it reads fine>"}}`.

## Results

| Reviewer | Set A | Set B |
|---|---|---|
| Strongest model (Opus 5.5) with the current rubric | 20/21 (95%), FP 0/6 | 12/13 (92%), FP 0/5 |
| Same, before the two additions to signals 8 and 12 (made from set A misses only) | 17/21 (81%), FP 1/6 | 11/13 (85%), FP 0/5 |
| Fast model (Haiku 5.5) reading and judging alone with `lazy-read-prompt.md` | 12/21 (57%), FP 1/6 | not run |

One run per cell, 2026-10-31, each by a fresh reviewer that saw only the exam and the rubric.
Single runs vary, so when a change moves a score by one item, run it again before trusting it.

Write each cell as caught/total (%) plus false positives, for example `20/21 (95%), FP 1/6`.
