# CLAUDE.md — working on claude-cockpit

This file orients a Claude Code session that is working on **claude-cockpit itself**
(the "Cockpit Dev" session opens here automatically).

## What this app is

An Electron desktop app that houses multiple Claude Code terminal sessions in one
window: workspaces (folder + default launch options), a side panel with each
session's live status (idle / working / waiting), sub-agent counts, per-workspace
git status + push/pull, and an **embedded per-session browser** Claude drives via
a Cockpit-owned MCP server (🌐 badge lights while browsing; external Chrome is a
per-session opt-in). It embeds the real `claude` TUI per pane (node-pty +
xterm.js) and observes state out-of-band via Claude Code hooks + transcript
watching — it does **not** reimplement Claude Code.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design. Key files:

- `src/main/index.ts` — app lifecycle, window, IPC, hook→status mapping, dev
  session auto-open, browser MCP config, relaunch.
- `src/main/sessions.ts` — `SessionManager`: ptys + `TerminalSession` state +
  persistence/restore + launch-flag building (embedded vs external browser).
- `src/main/ingest.ts` — localhost HTTP server (:47615) that Claude hooks POST to.
- `src/main/browser.ts` — `BrowserManager`: per-pane `WebContentsView` tabs,
  drive/observe/screenshot, persistent profile, overlay layout.
- `src/main/browser-rpc.ts` — localhost RPC (:47616) the browser MCP shim calls.
- `src/main/git.ts` — git status / push / pull for workspace dirs.
- `src/main/tmux.ts` — persistent tmux backing for the dev session.
- `src/main/transcripts.ts` — sub-agent counting from `~/.claude/projects/*.jsonl`.
- `src/main/store.ts` — JSON persistence (names, panes + browser tabs, workspaces, flags).
- `src/preload/index.ts` — the `window.cockpit` bridge.
- `src/renderer/src/` — React UI (`App.tsx`, `components/Sidebar.tsx`,
  `TerminalView.tsx`, `BrowserPanel.tsx`, `WorkspaceGit.tsx`, `LaunchDialog.tsx`,
  `SettingsPanel.tsx`).
- `src/shared/types.ts` — the main↔renderer contract; **change this first** when
  adding a feature.
- `hooks/emit.mjs` — the hook handler Claude runs; POSTs events to the app.
- `mcp/cockpit-browser.mjs` — stdio MCP server Claude spawns; forwards browser
  tool calls to the app, tagged with the pane id (keep dependency-free, like
  `emit.mjs`).

## Conventions

- TypeScript strict. Keep `src/shared/types.ts` the single source of truth.
- Status detection stays **out-of-band** — never scrape terminal output to infer
  state; use hooks / transcripts.
- Keep `hooks/emit.mjs` dependency-free and fast (it runs on every hook).
- Match surrounding code style.

## Build / verify before committing

```bash
npm run typecheck     # tsc on main+preload and renderer
npm run build         # bundles into out/
npx electron scripts/pty-smoke.cjs   # native pty loads → PTY_OUTPUT:"pty-ok"
npx electron scripts/webview-cdp-smoke.cjs   # embedded-browser control → SMOKE_RESULT: PASS
```

## How "rebuild & relaunch" works

The app persists every open pane (name, cwd, command, Claude `session_id`) to its
userData store on each change; on boot `SessionManager.restore()` respawns panes,
using `claude --resume <id>` to bring back conversations.

## Updating the installed app (local, no GitHub)

`npm run update-app` (→ `scripts/install-local.sh`) is the real update mechanism for
the packaged Desktop app: it rebuilds, swaps `Claude Cockpit.app` in place, and a
detached watcher relaunches it after the old instance quits. No notarization/signing
prompts — a locally-built app isn't quarantined. You can run this from the **Cockpit
Dev** session: the dev session's cwd is the real repo even in the packaged app,
because the repo path is baked in at build time via `__REPO_ROOT__`
(`electron.vite.config.ts` `define` → `REPO_ROOT` in `src/main/index.ts`).

Note: the in-app `relaunchApp()` only relaunches the current bundle — it can't
update a packaged app (the `out/` bundle lives in a read-only asar), so use
`update-app` to actually ship changes. `electron-updater` (`src/main/updater.ts`)
is wired for the GitHub-Releases path but dormant (no launch-time check).

## Git / GitHub

Public repo: `failurite/claude-cockpit` (origin, branch `main`). Commit with clear
messages; push when asked. Run the build before committing.

## Roadmap (see README)

The embedded per-session browser **superseded** the old "CDP tab mirror" roadmap
item — sessions drive in-app `WebContentsView` tabs via the `cockpit-browser` MCP
server. Remaining: split/grid layout, real synthetic input for the embedded
browser (CDP `Input.dispatch` — `scripts/webview-cdp-smoke.cjs` proves it works),
Windows/Linux.
