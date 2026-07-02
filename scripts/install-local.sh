#!/usr/bin/env bash
#
# Local update: rebuild Claude Cockpit and swap the installed app in place, then
# relaunch it. No GitHub, no notarization, no passwords — because the app is built
# on this machine it carries no quarantine flag, so macOS runs it freely.
#
# Run it from the repo (e.g. the "Cockpit Dev" session inside Cockpit):
#   npm run update-app
#
# Install location defaults to the Desktop; override with COCKPIT_APP_PATH.
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root
DEST="${COCKPIT_APP_PATH:-$HOME/Desktop/Claude Cockpit.app}"

# Build only for this machine's architecture (fast, single-arch).
case "$(uname -m)" in
  arm64)  ARCH_FLAG="--arm64"; BUILT="dist/mac-arm64/Claude Cockpit.app" ;;
  x86_64) ARCH_FLAG="--x64";   BUILT="dist/mac/Claude Cockpit.app" ;;
  *) echo "✗ Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

echo "▶ Building bundle…"
npm run build

echo "▶ Packaging app ($ARCH_FLAG)…"
# Local build: never notarize (that's only for apps distributed over the internet
# and would demand Apple credentials). The dir target produces just the .app.
npx --no-install electron-builder --mac dir "$ARCH_FLAG" -c.mac.notarize=false

if [[ ! -d "$BUILT" ]]; then
  echo "✗ Expected build output not found: $BUILT" >&2
  exit 1
fi

echo "▶ Installing to: $DEST"
rm -rf "$DEST"
cp -R "$BUILT" "$DEST"

# Prefer a graceful hand-off: tell the running app a fresh build is staged so it
# can prompt "restart now or later" and keep a restart button until you choose —
# instead of yanking the app out from under you. The app owns the relaunch in
# that case (it spawns its own reopen-after-quit watcher). 47615 is the fixed
# ingest port (INGEST_PORT in src/main/index.ts).
if curl -fsS -m 2 -X POST "http://127.0.0.1:47615/update-staged" \
     -H 'content-type: application/json' \
     --data-raw "{\"appPath\":\"$DEST\"}" >/dev/null 2>&1; then
  echo "✅ Update installed. Cockpit will prompt you to restart when you're ready."
  exit 0
fi

# Fallback (app not running, or an older build without the endpoint): detached
# watcher waits for the app to quit, then reopens the fresh one. `nohup … &`
# survives this script's terminal being torn down when the app quits.
echo "▶ Scheduling relaunch…"
nohup bash -c '
  while pgrep -f "Claude Cockpit.app/Contents/MacOS/" >/dev/null 2>&1; do sleep 1; done
  sleep 1
  open "'"$DEST"'"
' >/dev/null 2>&1 &
disown 2>/dev/null || true

echo "✅ Update installed. Relaunching Cockpit…"
osascript -e 'quit app "Claude Cockpit"' >/dev/null 2>&1 || true
