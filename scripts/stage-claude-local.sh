#!/bin/bash
# Stage a real, local copy of ~/.claude (currently a symlink into Google Drive).
# Copies entries one-by-one with a PER-FILE timeout, so any evicted cloud stub
# whose read hangs is skipped (logged) instead of stalling the whole migration.
set -u

GD="/Users/joebienkowski/Library/CloudStorage/GoogleDrive-failurite@gmail.com/My Drive/claude/.claude"
DEST="$HOME/.claude.local"
LIST="/tmp/claude-keep.list"
SKIPPED="/tmp/claude-skipped.list"
PER_FILE_TIMEOUT=4

[ -d "$GD" ] || { echo "FATAL: GD source not found: $GD"; exit 1; }
mkdir -p "$DEST"
: > "$SKIPPED"

# copy one file with a watchdog; returns 0 on success, 1 if it hung/failed.
# job-control chatter from the watchdog is suppressed via disown.
copyf() { # $1=src  $2=dst
  cp -p "$1" "$2" & local p=$!
  ( sleep "$PER_FILE_TIMEOUT"; kill -9 $p 2>/dev/null ) & local w=$!
  disown $w 2>/dev/null
  wait $p 2>/dev/null; local rc=$?
  kill -9 $w 2>/dev/null
  return $rc
}

echo "[stage] building readable-file list (excluding dataless stubs)…"
( cd "$GD" && find -x . ! -flags +dataless -print0 ) > "$LIST"
total=$(tr -dc '\0' < "$LIST" | wc -c | tr -d ' ')
echo "[stage] $total candidate entries"

copied=0; skipped=0; dirs=0
while IFS= read -r -d '' rel; do
  rel="${rel#./}"
  [ "$rel" = "." ] && continue
  src="$GD/$rel"; dst="$DEST/$rel"
  if [ -d "$src" ]; then
    mkdir -p "$dst"; dirs=$((dirs+1)); continue
  fi
  mkdir -p "$(dirname "$dst")"
  if copyf "$src" "$dst"; then
    copied=$((copied+1))
  else
    rm -f "$dst" 2>/dev/null   # drop any partial
    echo "$rel" >> "$SKIPPED"; skipped=$((skipped+1))
  fi
done < "$LIST"

# Fresh, readable settings.json so Cockpit re-installs its status hooks on launch.
[ -f "$DEST/settings.json" ] || echo '{}' > "$DEST/settings.json"

echo "[stage] dirs=$dirs  copied=$copied  skipped(hung)=$skipped"
echo "[stage] skipped files logged to $SKIPPED"
echo "[stage] staged size:"; du -sh "$DEST" 2>/dev/null
echo "[stage] DONE"
