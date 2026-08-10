#!/usr/bin/env python3
"""Validate every skill in skills/ against the Agent Skills spec.

https://agentskills.io/specification

Checks the constraints that actually break installs:
  - SKILL.md exists and starts with YAML frontmatter
  - `name` matches the spec pattern and the parent directory name
  - `description` is non-empty and <= 1024 characters
  - only spec fields are used, so the skill also uploads to claude.ai / the Skills API
    (Claude Code accepts more fields; those would fail packaging elsewhere)

Usage: scripts/validate.py [skills-dir]
Exits non-zero on the first failing skill set.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SPEC_FIELDS = {"name", "description", "license", "compatibility", "metadata", "allowed-tools"}
REQUIRED_FIELDS = {"name", "description"}
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
MAX_NAME = 64
MAX_DESCRIPTION = 1024
MAX_COMPATIBILITY = 500
FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)


def parse_frontmatter(text: str) -> dict:
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise ValueError("SKILL.md must open with a `---` YAML frontmatter block")
    try:
        import yaml
    except ImportError:  # pragma: no cover - CI installs pyyaml
        raise SystemExit("pyyaml is required: pip install pyyaml")
    data = yaml.safe_load(match.group(1))
    if not isinstance(data, dict):
        raise ValueError("frontmatter must be a YAML mapping")
    return data


def check(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        return [f"{skill_dir.name}: missing SKILL.md"]

    try:
        fm = parse_frontmatter(skill_md.read_text(encoding="utf-8"))
    except ValueError as exc:
        return [f"{skill_dir.name}: {exc}"]

    def err(msg: str) -> None:
        errors.append(f"{skill_dir.name}: {msg}")

    for field in sorted(REQUIRED_FIELDS - fm.keys()):
        err(f"missing required frontmatter field `{field}`")

    for field in sorted(fm.keys() - SPEC_FIELDS):
        err(
            f"frontmatter field `{field}` is outside the Agent Skills spec; "
            "claude.ai upload and the Skills API reject it"
        )

    name = fm.get("name")
    if isinstance(name, str):
        if len(name) > MAX_NAME:
            err(f"`name` is {len(name)} chars, max {MAX_NAME}")
        if not NAME_RE.match(name):
            err(f"`name` {name!r} must be lowercase alphanumeric with single hyphens, no leading/trailing hyphen")
        if name != skill_dir.name:
            err(f"`name` {name!r} must match the directory name {skill_dir.name!r}")
    elif name is not None:
        err("`name` must be a string")

    description = fm.get("description")
    if isinstance(description, str):
        if not description.strip():
            err("`description` must be non-empty")
        if len(description) > MAX_DESCRIPTION:
            err(f"`description` is {len(description)} chars, max {MAX_DESCRIPTION}")
    elif description is not None:
        err("`description` must be a string")

    compatibility = fm.get("compatibility")
    if isinstance(compatibility, str) and len(compatibility) > MAX_COMPATIBILITY:
        err(f"`compatibility` is {len(compatibility)} chars, max {MAX_COMPATIBILITY}")

    metadata = fm.get("metadata")
    if metadata is not None and not isinstance(metadata, dict):
        err("`metadata` must be a mapping")

    return errors


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent / "skills"
    if not root.is_dir():
        print(f"error: no such directory: {root}", file=sys.stderr)
        return 1

    skill_dirs = sorted(d for d in root.iterdir() if d.is_dir() and not d.name.startswith("."))
    if not skill_dirs:
        print(f"error: no skills found in {root}", file=sys.stderr)
        return 1

    all_errors: list[str] = []
    for skill_dir in skill_dirs:
        errors = check(skill_dir)
        all_errors.extend(errors)
        status = "FAIL" if errors else "ok"
        print(f"[{status}] {skill_dir.name}")

    for error in all_errors:
        print(f"  - {error}", file=sys.stderr)

    if all_errors:
        print(f"\n{len(all_errors)} problem(s) in {len(skill_dirs)} skill(s)", file=sys.stderr)
        return 1

    print(f"\n{len(skill_dirs)} skill(s) valid")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
