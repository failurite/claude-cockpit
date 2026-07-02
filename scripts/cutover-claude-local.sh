#!/bin/bash
# CUTOVER: replace the ~/.claude symlink (which points into Google Drive) with the
# real local directory staged at ~/.claude.local.
#
#   RUN THIS FROM Terminal.app — NOT from inside Claude Code or Cockpit,
#   and AFTER you have quit both, so nothing is writing to ~/.claude mid-swap.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
LINK="$HOME/.claude"
DEST="$HOME/.claude.local"
GD="/Users/joebienkowski/Library/CloudStorage/GoogleDrive-failurite@gmail.com/My Drive/claude/.claude"

# Safety checks ------------------------------------------------------------
if pgrep -fl "Claude Cockpit" >/dev/null 2>&1; then
  echo "ABORT: 'Claude Cockpit' is still running. Quit it first."; exit 1
fi
if pgrep -x "claude" >/dev/null 2>&1; then
  echo "WARN: a 'claude' process is still running. Quit all Claude Code sessions, then re-run."; exit 1
fi
if [ ! -L "$LINK" ]; then
  echo "ABORT: $LINK is not a symlink — nothing to cut over (already migrated?)."; exit 1
fi
if [ ! -d "$DEST" ]; then
  echo "ABORT: staged dir $DEST not found. Run scripts/stage-claude-local.sh first."; exit 1
fi

# Final delta: re-run the resilient per-file copy to grab anything written since
# staging (cp -p overwrites with the newer Google Drive copy; hung stubs skipped).
echo "[cutover] final delta sync from Google Drive copy…"
bash "$HERE/stage-claude-local.sh"

# Swap: drop the symlink, move the real dir into place ---------------------
echo "[cutover] swapping symlink → real local directory…"
rm "$LINK"
mv "$DEST" "$LINK"

echo
echo "[cutover] DONE. ~/.claude is now a real local directory:"
ls -ldO "$LINK"
echo
echo "The old Google Drive copy still exists at:"
echo "  $GD"
echo "It is no longer linked. Leave it, or later remove/unpin it in Google Drive."
echo
echo "Next: relaunch Claude Cockpit. It re-installs its status hooks into the fresh"
echo "settings.json on launch. Plugins that were partially evicted may need reinstalling."
