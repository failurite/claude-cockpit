# CLAUDE.md — working on claude-cockpit

This file orients a Claude Code session that is working on **claude-cockpit itself**
(the "Cockpit Dev" session opens here automatically).

## What this app is

An Electron desktop app that houses multiple Claude Code terminal sessions in one
window: workspaces (folder + default launch options), a side panel with each
session's live status (idle / working / waiting), sub-agent counts, per-workspace
git status + push/pull, and an **embedded per-session browser** Claude drives via
a Cockpit-owned MCP server (🌐 badge lights while browsing; external Chrome is a
per-session opt-in). Sessions can also **see each other** — a second MCP server
lets one session list its siblings and read a digest of another's context to
coordinate related work. Sessions can be **archived** (closed but saved) and
reopened later with their conversation (`--resume`) + browser tabs intact. It
embeds the real `claude` TUI per pane (node-pty +
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
- `src/main/sessions-rpc.ts` — localhost RPC (:47617) the cross-session MCP shim
  calls: list sibling sessions / read another session's transcript digest.
- `src/main/git.ts` — git status / push / pull for workspace dirs (exports `runGit`).
- `src/main/issues.ts` — gh CLI wrapper: list/view/close issues, list repo labels,
  create an issue (`--body-file`), and upload a pasted image to GitHub's
  user-attachments store (undocumented `uploads.github.com` endpoint, Bearer token)
  so it can be embedded in an issue body.
- `src/main/worktrees.ts` — per-issue worktree/branch isolation + the serialized
  Done flow (rebase → merge to default branch → push → cleanup).
- `src/main/tmux.ts` — persistent tmux backing for **every** claude session
  (macOS/Linux only; `tmuxBin()` short-circuits to null on Windows). Each pane's
  tmux name IS its pane id (stable across restarts, so the frozen hook env still
  matches); `tmuxWrap()` is the generic attach-or-create. Sessions are killed on
  close/archive/workspace-remove and a boot-time `sweepOrphanTmux()` clears any
  left by a crash — so tmux never leaks past a pane. Opt out via the
  `disableSessionTmux` flag (dev always persists).
- `src/main/platform.ts` — the cross-platform choke point: `buildShellInvocation()`
  (login-zsh `exec` on POSIX vs `cmd.exe /c` on Windows), `quoteArg`/`quotePath`
  (POSIX single-quote vs Windows double-quote, no backslash-doubling), `NPM_BIN`,
  `IS_MAC`/`IS_WINDOWS`. Touch this — not ad-hoc `process.platform` checks — when
  adding OS-specific behavior.
- `src/main/transcripts.ts` — sub-agent counting + per-session token totals from
  `~/.claude/projects/*.jsonl`.
- `src/main/monitor.ts` — `SystemMonitor`: samples system CPU/memory + Claude token
  throughput and pushes `SystemStats` to the renderer for the sidebar meters.
- `src/main/store.ts` — JSON persistence (names, panes + browser tabs, workspaces,
  flags, and a durable `uiState` bag — collapsed workspaces, active session,
  per-workspace issue panel filter/expanded — via the `ui.get`/`ui.set` bridge; use
  this, not renderer `localStorage`, for state that must survive restarts, since
  `localStorage` is origin-scoped across dev vs packaged builds).
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
- `mcp/cockpit-sessions.mjs` — stdio MCP server for cross-session coordination
  (`cockpit_list_sessions` / `cockpit_read_session`); forwards to `sessions-rpc.ts`
  tagged with the pane id (keep dependency-free, like `emit.mjs`).

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

The app persists every open pane (name, cwd, command, Claude `session_id`, tmux
name) to its userData store on each change; on boot `SessionManager.restore()`
respawns panes. On macOS/Linux each pane is tmux-backed, so restore **re-attaches
the still-running claude process** (live state intact); if the tmux session is
gone (or on Windows) it falls back to `claude --resume <id>` to bring back the
conversation in a fresh process.

## Updating the installed app (local, no GitHub)

`npm run update-app` (→ `scripts/update-app.mjs`, which dispatches to
`install-local.sh` on macOS / `install-local.ps1` on Windows) is the local update
mechanism for the packaged Desktop app: it rebuilds and swaps the installed app in
place. On macOS it then **POSTs `/update-staged` to the running app's ingest
server (:47615)** rather than force-quitting — the app shows a "restart now / later"
prompt and keeps a **⟳ Restart to update** button in the sidebar until you choose;
restarting spawns a detached watcher that reopens the fresh build after quit
(`applyStagedUpdate` in `src/main/index.ts`). If the app isn't reachable (not
running, or an older build without the endpoint) the script falls back to the old
detached-watcher + `osascript quit` auto-relaunch. No notarization/signing prompts
— a locally-built app isn't quarantined. You can run this from the **Cockpit Dev**
session: the dev session's cwd is the real repo even in the packaged app, because
the repo path is baked in at build time via `__REPO_ROOT__`
(`electron.vite.config.ts` `define` → `REPO_ROOT` in `src/main/index.ts`).

Note: `update-app` only builds the platform it runs on. To ship a feature to BOTH
platform releases, push a version tag (`v*`) — `.github/workflows/release.yml`
builds macOS + Windows from the same commit and publishes both to a GitHub Release,
and the app auto-updates from that feed (launch-time check in
`src/main/updater.ts`). The in-app `relaunchApp()` only relaunches the current
bundle — it can't update a packaged app (the `out/` bundle lives in a read-only
asar).

## Cross-platform (macOS + Windows)

- All OS differences route through `src/main/platform.ts` — don't sprinkle
  `process.platform` checks. The pane shell, arg/path quoting, and `npm` binary
  all come from there.
- Windows has no tmux: `tmuxBin()` returns null, so all sessions use the ephemeral
  pane + `claude --resume` fallback (no live-process persistence across restarts —
  acceptable, conversations still restore). tmux persistence is a macOS/Linux-only
  enhancement; there's no clean Windows equivalent.
- The out-of-band plumbing is already portable: hooks run as `node "<path>"`
  (`hooks-install.ts`, via `quotePath` so Windows `C:\…` paths aren't backslash-
  doubled) and MCP shims via `{ command: 'node', args: [...] }`. Both require
  `node` on `PATH` in the Claude session's environment.
- Windows builds are **unsigned** for now (SmartScreen warns on first download).

## Git / GitHub

Public repo: `failurite/claude-cockpit` (origin, branch `main`). Each feature or
bug fix gets its own commit with a clear description of what changed, **pushed to
origin immediately** — don't accumulate unpushed commits. Keep the docs current in
the same change. Run typecheck + build before committing. (Never commit the
personal `scripts/*-claude-local.sh` migration scripts.)

## Roadmap (see README)

The embedded per-session browser **superseded** the old "CDP tab mirror" roadmap
item — sessions drive in-app `WebContentsView` tabs via the `cockpit-browser` MCP
server. Remaining: split/grid layout, real synthetic input for the embedded
browser (CDP `Input.dispatch` — `scripts/webview-cdp-smoke.cjs` proves it works),
Linux. Windows is now experimentally supported (see the cross-platform section).
