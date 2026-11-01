# Security

What you install from this repo runs on your machine: `install.sh` copies files and can edit
`~/.claude/settings.json`, and the plugin's hooks run on every prompt. So `main` is guarded.

## What has to pass before a change reaches `main`

- `main` only takes pull requests. Force pushes and branch deletion are blocked.
- These checks must pass on the pull request:
  - **validate** — the Agent Skills spec, the manifests, shellcheck, the idle-return hook test, packaging
  - **secrets (gitleaks)** — no credentials anywhere in the history
  - **workflows (zizmor)** — no unsafe GitHub Actions patterns
  - **codeql** — static analysis of the TypeScript (HUD), Python and Actions code
- Every action is pinned to a commit SHA. Dependabot proposes updates weekly, after a 7-day cooldown.
- GitHub secret scanning with push protection is on.

## Reporting a vulnerability

Please use [private vulnerability reporting](https://github.com/lycfyi/yskills/security/advisories/new)
rather than a public issue.
