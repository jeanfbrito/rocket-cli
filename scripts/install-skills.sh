#!/usr/bin/env bash
#
# install-skills.sh — symlink this repo's Claude Code skills into ~/.claude/skills.
#
# Each skills/<name>/ directory is linked to ~/.claude/skills/<name>, so edits
# in the repo propagate live. Idempotent: re-running is safe.
#
#   ./scripts/install-skills.sh             install (or refresh) the symlinks
#   ./scripts/install-skills.sh --uninstall remove only symlinks pointing into this repo
#
set -euo pipefail

# Resolve the repo root from this script's own location, not the caller's CWD.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
SKILLS_DEST="${HOME}/.claude/skills"

UNINSTALL=0
if [ "${1:-}" = "--uninstall" ]; then
  UNINSTALL=1
elif [ -n "${1:-}" ]; then
  echo "Unknown argument: $1" >&2
  echo "Usage: $0 [--uninstall]" >&2
  exit 2
fi

if [ ! -d "$SKILLS_SRC" ]; then
  echo "No skills directory found at: $SKILLS_SRC" >&2
  exit 1
fi

installed=0
skipped=0
removed=0

if [ "$UNINSTALL" -eq 1 ]; then
  # Remove only symlinks under ~/.claude/skills that resolve into this repo's skills/.
  if [ -d "$SKILLS_DEST" ]; then
    for link in "$SKILLS_DEST"/*; do
      [ -e "$link" ] || [ -L "$link" ] || continue
      if [ -L "$link" ]; then
        target="$(readlink "$link")"
        case "$target" in
          "$SKILLS_SRC"/*)
            rm "$link"
            echo "removed:   $link"
            removed=$((removed + 1))
            ;;
          *)
            ;;
        esac
      fi
    done
  fi
  echo "---"
  echo "Uninstall summary: $removed removed."
  exit 0
fi

mkdir -p "$SKILLS_DEST"

for dir in "$SKILLS_SRC"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  src="$(cd "$dir" && pwd)"
  dest="$SKILLS_DEST/$name"

  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    # Real directory/file already there — never delete user data.
    echo "skipped:   $dest exists and is not a symlink (left untouched)"
    skipped=$((skipped + 1))
    continue
  fi

  # -f replaces an existing symlink, -n avoids descending into a dir symlink.
  ln -sfn "$src" "$dest"
  echo "installed: $dest -> $src"
  installed=$((installed + 1))
done

echo "---"
echo "Install summary: $installed installed, $skipped skipped."
