#!/usr/bin/env python3
"""Score a cold-read run against the answer key.

Usage: python3 score.py a "1,2,4,..."
The second argument is the reviewer's FLAGGED line: the item numbers it flagged.
A leading "FLAGGED:" and "#" before numbers are accepted; full-width commas too.
"""
import json
import os
import re
import sys


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1].lower() not in ("a", "b"):
        print('usage: python3 score.py a|b "1,2,4,..."', file=sys.stderr)
        return 2
    which, flagged = sys.argv[1].lower(), sys.argv[2].strip()
    key_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"key-{which}.json")
    with open(key_path, encoding="utf-8") as f:
        key = json.load(f)

    if flagged.upper().startswith("FLAGGED:"):
        flagged = flagged[len("FLAGGED:"):]
    got = {x.lstrip("#") for x in re.split(r"[\s,，]+", flagged) if x.lstrip("#")}

    bad, good = set(key["bad"]), set(key["good"])
    hit = sorted(got & bad, key=int)
    miss = sorted(bad - got, key=int)
    fp = sorted(got & good, key=int)
    unknown = sorted(got - bad - good)

    print(f"Caught {len(hit)}/{len(bad)} ({len(hit) / len(bad):.0%}), "
          f"false positives on fine items {len(fp)}/{len(good)}")
    print("Missed:" + ("" if miss else " none"))
    for m in miss:
        print(f"  #{m} {key['bad'][m]}")
    print("False positives:" + ("" if fp else " none"))
    for m in fp:
        print(f"  #{m} (reads fine because: {key['good'][m]})")
    if unknown:
        print("Ignored, not in the key:", ", ".join(unknown))
    return 0


if __name__ == "__main__":
    sys.exit(main())
