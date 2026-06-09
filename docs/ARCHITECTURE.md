# Architecture

`claude-cockpit` is an [Electron](https://www.electronjs.org/) app built with
[electron-vite](https://electron-vite.org/) (Vite + React renderer, bundled
main/preload). It embeds real Claude Code sessions and observes them through
Claude Code's own extension points rather than reimplementing anything.

## Why this stack

- **Electron + xterm.js + node-pty** is the proven way to embed *real* terminals
  in a desktop app — it's literally the stack VS Code's integrated terminal uses,
  minus the editor. `node-pty` spawns a genuine OS pseudo-terminal in the main
  process; `xterm.js` is only the on-screen view. So a pane *is* the Claude Code
  TUI, with full color/resize/`Ctrl-C` fidelity.
- We chose [`@homebridge/node-pty-prebuilt-multiarch`](https://www.npmjs.com/package/@homebridge/node-pty-prebuilt-multiarch)
  because it ships prebuilt binaries for both Node and Electron ABIs, avoiding a
  native compile / `electron-rebuild` step. `scripts/pty-smoke.cjs` verifies it
  loads under the current Electron.
- VS Code (extension or fork) was evaluated and rejected: its terminal API can't
  reliably read session state, and webviews can't embed a live, CDP-driven Chrome
  tab — which is exactly the Chrome feature we want.

## Process model

```
src/
├── main/                     Electron main process (Node)
│   ├── index.ts              app lifecycle, window, IPC wiring, hook→status map,
│   │                         dev-session auto-open, browser MCP config, relaunch
│   ├── sessions.ts           SessionManager: ptys + TerminalSession state,
│   │                         persistence/restore (claude --resume), launch flags
│   ├── ingest.ts             localhost HTTP server (:47615) that hooks POST to
│   ├── browser.ts            BrowserManager: per-pane WebContentsView tabs,
│   │                         drive (navigate/click/type/read/screenshot), layout
│   ├── browser-rpc.ts        localhost RPC (:47616) the MCP shim calls
│   ├── git.ts                git status / push / pull per workspace dir
│   ├── tmux.ts               persistent tmux backing for the dev session
│   ├── transcripts.ts        chokidar watcher → active sub-agent count
│   ├── hooks-install.ts      read/modify ~/.claude/settings.json (managed block)
│   ├── updater.ts            electron-updater wiring (dormant; GitHub Releases)
│   └── store.ts              JSON persistence: names, panes (+ browser tabs),
│                             workspaces, one-time flags
├── preload/
│   └── index.ts              contextBridge → window.cockpit (typed API)
├── renderer/                 React UI
│   └── src/
│       ├── App.tsx           layout, session state, browser panel toggle
│       └── components/
│           ├── Sidebar.tsx       workspaces + sessions, status dots, rename
│           ├── WorkspaceGit.tsx  branch / ↑↓ counts / Pull / Push row
│           ├── TerminalView.tsx  one xterm.js view bound to a pty
│           ├── BrowserPanel.tsx  tab strip + URL bar + bounds for the overlay
│           ├── LaunchDialog.tsx  workspace / custom-session options dialog
│           └── SettingsPanel.tsx hooks, tmux cleanup, close-all, updates
├── shared/
│   └── types.ts              the main↔renderer contract (single source of truth)
├── hooks/
│   └── emit.mjs              the hook handler Claude runs; POSTs events to the app
└── mcp/
    └── cockpit-browser.mjs   stdio MCP server Claude spawns; forwards browser
                              tool calls to the app's RPC, tagged with its pane id
```

### Data flow

- **Output:** `node-pty` `onData` → `SessionManager` emits `data` → main
  `webContents.send('pty:data', paneId, chunk)` → preload fans out to the
  subscribed `TerminalView` → `term.write()`. Main also keeps a capped per-pane
  buffer so a freshly mounted view can replay missed output via `pty:attach`.
- **Input:** `xterm` `onData` → `cockpit.write` → `ipcRenderer.send('pty:write')`
  → `pty.write()`.
- **State:** any change to a `TerminalSession` (status, name, sub-agent count)
  triggers `SessionManager` to emit `sessions`, broadcast as `sessions:changed`,
  re-rendering the sidebar/status bar.

## Status pipeline

The status signal is intentionally **out-of-band** from the terminal stream.

1. Each pty is spawned with `CLAUDE_COCKPIT_PANE_ID` and
   `CLAUDE_COCKPIT_INGEST_PORT` in its environment.
2. Claude Code hooks (installed in `~/.claude/settings.json`) run `hooks/emit.mjs`,
   which **inherits those env vars**, reads the hook JSON on stdin, tags it with
   the pane id, and POSTs it to `http://127.0.0.1:<port>/`.
3. `handleHookEvent` in `main/index.ts` maps the event to a `SessionStatus` and,
   when the payload carries Claude's `session_id`, binds it to the pane
   (`bindClaudeSession`) so future events that only know Claude's id still map
   home, and so the transcript watcher knows which file to tail.

Why hooks instead of scraping the terminal? VS Code's own terminal-reading API is
unstable, and TUI scraping is brittle. Hooks are a documented, structured signal.

### Status states

`starting · idle · working · waiting · exited` — see `SessionStatus` in
`shared/types.ts`. `waiting` is the one that matters most: it means Claude needs
*you* (a permission grant or a question).

## Transcript watcher / sub-agent count

Once a pane's Claude `session_id` is known, `transcripts.ts` locates
`~/.claude/projects/<project>/<session_id>.jsonl` (waiting for it to appear if
needed) and counts `Task` tool calls without a matching `tool_result` — an
approximation of "sub-agents currently running". The transcript schema we rely on:
each line is a JSON object with `sessionId`, a `message.content[]` array of blocks
(`tool_use` / `tool_result`), and `isSidechain: true` on sub-agent lines.

This is a heuristic and a good place to contribute a more exact implementation
(e.g. pairing `SubagentStart`/`SubagentStop` hooks if/when available).

## Workspaces, persistence & the dev session

- **Workspaces** (`shared/types.ts` `Workspace`) are a directory + default
  `SessionOptions`, stored in the JSON store. New sessions resolve cwd + options
  from their workspace; the LaunchDialog overrides them per session. Paths are
  tilde-expanded at the spawn choke point (`expandTilde` in `sessions.ts`) so a
  hand-typed `~/code/x` can't make `pty.spawn` fail.
- **Persistence/restore:** `SessionManager.persist()` writes every pane (name,
  cwd, command, kind, options, Claude `session_id`, embedded-browser tab URLs) on
  each change; `restore()` respawns them on boot with `claude --resume <id>` and
  reopens their browser tabs.
- **Cockpit workspace:** the app's own repo is a built-in workspace
  (`COCKPIT_WORKSPACE_ID`), *synthesized* by `listAllWorkspaces()` rather than
  stored — present by default, not editable/deletable, hidden via the
  `hideCockpitWorkspace` setting. Dev-kind sessions are always grouped into it.
- **Dev session:** `createDevSession()` opens in the app's own repo (baked in at
  build time via `__REPO_ROOT__`) and auto-opens on every launch. With tmux
  installed it runs inside a persistent `cockpit-dev` tmux session, so the real
  `claude` process survives app restarts — Cockpit re-attaches with
  `tmux new-session -A`. **Caveat:** `-A` only applies launch flags when the tmux
  session is *first created*; a long-lived tmux session keeps its original flags
  until killed (Settings → tmux → Kill).

## Embedded browser (implemented)

Each session can have its own in-app browser that Claude drives — no external
Chrome. Self-containment was the goal; claude-in-chrome can't do this because it
attaches to real Chrome via an account-authenticated extension, which Electron
can't run.

```
claude (pane)  ──spawns──►  mcp/cockpit-browser.mjs   (stdio MCP server)
                              │  newline-delimited JSON-RPC; tags every call
                              │  with CLAUDE_COCKPIT_PANE_ID from inherited env
                              ▼
              Browser RPC server (127.0.0.1:47616, browser-rpc.ts)
                              ▼
              BrowserManager (browser.ts) ── owns WebContentsView tabs per pane
                              ▼
              renderer BrowserPanel reserves a rectangle; main positions the
              active tab's view over it (only the foreground pane's active tab
              is visible)
```

- **Launch wiring:** with `options.chrome` on (default), `claudeFlags()` emits
  `--no-chrome --mcp-config <userData>/cockpit-browser.mcp.json` instead of
  `--chrome`. The config registers `mcp/cockpit-browser.mjs` (shipped as an
  extraResource, like `hooks/`). `--no-chrome` is the key: it disables Claude's
  native Claude-in-Chrome connector (which is on by default globally via
  `claudeInChromeDefaultEnabled`), so a session can't pop open a real external
  Chrome window — it browses only through the embedded WebContentsView. Every
  non-external path (including no-browser sessions like the dev pane) gets
  `--no-chrome`. Opting into `options.externalChrome` (LaunchDialog) restores the
  old `--chrome` behavior for that session.
- **Tools exposed to Claude:** `browser_open_tab / navigate / list_tabs /
  close_tab / click / type / read_text / screenshot`.
- **Driving:** v1 uses Electron's high-level APIs (`loadURL`,
  `executeJavaScript` for click/type/read, `capturePage` for screenshots).
  `scripts/webview-cdp-smoke.cjs` proves full CDP control
  (`webContents.debugger`, real `Input.dispatchMouseEvent`) works if/when we
  upgrade to synthetic input.
- **Profile:** all tabs share one persistent partition
  (`persist:cockpit-browser`) so logins survive restarts, with the
  `Electron`/app tokens stripped from the user agent so sign-in pages don't
  reject the browser. Chrome's password manager / Sync are **not** available —
  that's proprietary Chrome, not Chromium.
- **Status badge:** independently of all this, `handleHookEvent` flags a session
  as `usingChrome` when a `PreToolUse` event carries a browser MCP tool
  (`isBrowserTool`/`browserToolTarget` in `main/index.ts`) and clears it on
  `Stop` — that's what lights the 🌐 badge, for embedded and external alike.

## Issue-driven sessions

GitHub issues become dedicated, concurrent sessions with clean repo sync:

- **Source:** `issues.ts` wraps the `gh` CLI (`issue list/view/close`) in the
  workspace dir — reuses the user's gh auth, fully non-interactive.
- **Isolation:** `worktrees.ts` gives each issue a git worktree + branch
  (`issue/<n>-<slug>`, from `origin/<default>`), stored under
  `userData/worktrees/<repo>/issue-<n>` so the main checkout's `git status`
  stays clean. Concurrent sessions can never touch each other's files.
- **Mapping:** `TerminalSession.issue` (`IssueRef`: number/title/url/branch/
  worktree/repoDir) is set at spawn, shown as a `#<n>` chip, and persisted so
  restarts keep the mapping. The issue body is written *beside* the worktree
  (never committable) and referenced from the kickoff prompt.
- **Done flow** (`finishIssueWorktree`, serialized through a module-level merge
  queue so only one issue lands at a time): require a clean worktree → fetch →
  `rebase origin/<default>` → `push origin HEAD:refs/heads/<default>` (or local
  `merge --ff-only` when there's no remote) → best-effort `pull --ff-only` in
  the main checkout → `worktree remove` + `branch -D` → `gh issue close
  --comment` with the merged-commit summary → close the pane.
- **Failure handling:** `dirty` and `conflict` results leave the worktree
  intact and Cockpit *types instructions into that session's pty* so its Claude
  commits / resolves the rebase; the user presses Done again.

## Git (per workspace)

`git.ts` shells out to `git -C <dir>` with `GIT_TERMINAL_PROMPT=0` (auth failures
return fast instead of hanging): `gitStatus` (branch, upstream, ahead/behind via
`rev-list --left-right --count @{u}...HEAD`, dirty via `status --porcelain`),
`gitPush`, `gitPull`. `WorkspaceGit.tsx` renders the row per workspace — and for
the dev session's repo under "Other" — doing a fast local read on mount plus a
background `git fetch` so the behind/unpulled count is meaningful.

## Extending

- **Add a status source:** handle a new event in `handleHookEvent` and add the
  event name to `EVENTS` in `hooks-install.ts`.
- **Add UI:** the renderer only depends on `shared/types.ts` + `window.cockpit`.
  Add a method to `CockpitApi`, implement it in `preload/index.ts` + an IPC handler
  in `main/index.ts`.
- **Change the terminal:** `TerminalView.tsx` is self-contained; swap themes,
  fonts, or addons there.
