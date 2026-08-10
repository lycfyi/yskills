#!/usr/bin/env bash
# yskills installer — copies Agent Skills into any skills-compatible agent.
#
#   ./install.sh                       # install all skills for Claude Code (~/.claude/skills)
#   ./install.sh --agent codex         # install for Codex (~/.agents/skills)
#   ./install.sh --agent all           # install everywhere an agent dir already exists
#   ./install.sh --dir ./.claude/skills whats-next
#   ./install.sh --link                # symlink instead of copy (edits track the repo)
#   ./install.sh --list                # show skills and resolved targets, install nothing
#
# Remote one-liner (clones to a temp dir, installs, cleans up):
#   curl -fsSL https://raw.githubusercontent.com/lycfyi/yskills/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/lycfyi/yskills/main/install.sh | bash -s -- --agent codex

set -euo pipefail

REPO_URL="https://github.com/lycfyi/yskills.git"
AGENT="claude"
CUSTOM_DIR=""
MODE="copy"
FORCE=0
LIST_ONLY=0
SKILLS=()
CLEANUP_DIR=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

usage() {
  # Reprint the header comment block (everything between the shebang and the first blank/code line).
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
  cat <<'EOF'

Options:
  --agent <name>   claude | claude-project | codex | codex-project | cursor |
                   opencode | goose | all           (default: claude)
  --dir <path>     Install into an explicit directory (overrides --agent)
  --link           Symlink skills instead of copying
  --force          Overwrite existing skills without asking
  --list           Print skills and resolved target, then exit
  -h, --help       Show this help

Arguments:
  Zero or more skill names. Default: every skill in the repo.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="${2:-}"; [ -n "$AGENT" ] || die "--agent needs a value"; shift 2 ;;
    --dir) CUSTOM_DIR="${2:-}"; [ -n "$CUSTOM_DIR" ] || die "--dir needs a value"; shift 2 ;;
    --link) MODE="link"; shift ;;
    --force) FORCE=1; shift ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) SKILLS+=("$1"); shift ;;
  esac
done

# --- locate the skills source -------------------------------------------------
# Works both from a clone and from `curl ... | bash`, where $0 is not a real file.
SRC=""
if [ -f "${BASH_SOURCE[0]:-}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -d "$SELF_DIR/skills" ] && SRC="$SELF_DIR/skills"
fi
if [ -z "$SRC" ]; then
  [ "$MODE" = "link" ] && die "--link needs a local clone; run it from a checkout of the repo"
  command -v git >/dev/null 2>&1 || die "git is required to install from a pipe"
  CLEANUP_DIR="$(mktemp -d)"
  trap 'rm -rf "$CLEANUP_DIR"' EXIT
  info "Cloning $REPO_URL ..."
  git clone --depth 1 --quiet "$REPO_URL" "$CLEANUP_DIR/yskills"
  SRC="$CLEANUP_DIR/yskills/skills"
fi
[ -d "$SRC" ] || die "no skills/ directory found at $SRC"

# --- resolve target directories ----------------------------------------------
target_for() {
  case "$1" in
    claude)         printf '%s\n' "$HOME/.claude/skills" ;;
    claude-project) printf '%s\n' "$PWD/.claude/skills" ;;
    codex)          printf '%s\n' "$HOME/.agents/skills" ;;
    codex-project)  printf '%s\n' "$PWD/.agents/skills" ;;
    cursor)         printf '%s\n' "$HOME/.cursor/skills" ;;
    opencode)       printf '%s\n' "$HOME/.config/opencode/skills" ;;
    goose)          printf '%s\n' "$HOME/.config/goose/skills" ;;
    *) return 1 ;;
  esac
}

# Is this agent actually present on the machine? Used only by --agent all, so that
# installing "everywhere" doesn't create config homes for tools you never run.
# Codex reads ~/.agents/skills but keeps its config in ~/.codex, so check both.
agent_present() {
  case "$1" in
    claude)   [ -d "$HOME/.claude" ] ;;
    codex)    [ -d "$HOME/.agents" ] || [ -d "$HOME/.codex" ] ;;
    cursor)   [ -d "$HOME/.cursor" ] ;;
    opencode) [ -d "$HOME/.config/opencode" ] ;;
    goose)    [ -d "$HOME/.config/goose" ] ;;
    *) return 1 ;;
  esac
}

TARGETS=()
if [ -n "$CUSTOM_DIR" ]; then
  TARGETS+=("$CUSTOM_DIR")
elif [ "$AGENT" = "all" ]; then
  for a in claude codex cursor opencode goose; do
    if agent_present "$a"; then TARGETS+=("$(target_for "$a")"); fi
  done
  [ ${#TARGETS[@]} -gt 0 ] || die "no known agent directories found; use --agent <name> or --dir <path>"
else
  t="$(target_for "$AGENT")" || die "unknown agent: $AGENT (try --help)"
  TARGETS+=("$t")
fi

# --- resolve skill list -------------------------------------------------------
ALL_SKILLS=()
for d in "$SRC"/*/; do
  [ -f "$d/SKILL.md" ] || continue
  ALL_SKILLS+=("$(basename "$d")")
done
[ ${#ALL_SKILLS[@]} -gt 0 ] || die "no skills found in $SRC"

if [ ${#SKILLS[@]} -eq 0 ]; then
  SKILLS=("${ALL_SKILLS[@]}")
else
  for s in "${SKILLS[@]}"; do
    [ -f "$SRC/$s/SKILL.md" ] || die "no such skill: $s (available: ${ALL_SKILLS[*]})"
  done
fi

if [ "$LIST_ONLY" -eq 1 ]; then
  info "Skills:  ${ALL_SKILLS[*]}"
  info "Targets: ${TARGETS[*]}"
  info "Mode:    $MODE"
  exit 0
fi

# --- install ------------------------------------------------------------------
installed=0
for target in "${TARGETS[@]}"; do
  mkdir -p "$target"
  for s in "${SKILLS[@]}"; do
    dest="$target/$s"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      if [ "$FORCE" -eq 1 ]; then
        rm -rf "$dest"
      elif [ -t 0 ]; then
        printf '%s already exists. Overwrite? [y/N] ' "$dest"
        read -r reply
        case "$reply" in [yY]*) rm -rf "$dest" ;; *) info "  skipped $s"; continue ;; esac
      else
        info "  skipped $s (exists at $dest; re-run with --force to overwrite)"
        continue
      fi
    fi
    if [ "$MODE" = "link" ]; then
      ln -s "$(cd "$SRC/$s" && pwd)" "$dest"
      info "  linked  $s -> $dest"
    else
      cp -R "$SRC/$s" "$dest"
      info "  copied  $s -> $dest"
    fi
    installed=$((installed + 1))
  done
done

if [ "$installed" -eq 0 ]; then
  info "Nothing installed."
  exit 0
fi

printf '\nInstalled %s skill(s). Restart your agent if it does not pick them up, then try:\n' "$installed"
for s in "${SKILLS[@]}"; do printf '  /%s\n' "$s"; done
