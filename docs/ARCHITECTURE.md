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
│   ├── index.ts              app lifecycle, window, IPC wiring, hook→status map
│   ├── sessions.ts           SessionManager: ptys + derived TerminalSession state
│   ├── ingest.ts             localhost HTTP server that hooks POST to
│   ├── transcripts.ts        chokidar watcher → active sub-agent count
│   ├── hooks-install.ts      read/modify ~/.claude/settings.json (managed block)
│   └── store.ts              tiny JSON persistence (session names)
├── preload/
│   └── index.ts              contextBridge → window.cockpit (typed API)
├── renderer/                 React UI
│   └── src/
│       ├── App.tsx           layout, session state, hook-install banner
│       └── components/
│           ├── Sidebar.tsx       session list, status dots, inline rename
│           └── TerminalView.tsx  one xterm.js view bound to a pty
├── shared/
│   └── types.ts              the main↔renderer contract (single source of truth)
└── hooks/
    └── emit.mjs              the hook handler Claude runs; POSTs events to the app
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

## Chrome integration

**Implemented: activity detection.** `handleHookEvent` flags a session as
`usingChrome` when a `PreToolUse` event carries a browser MCP tool
(`mcp__…chrome…`, see `isBrowserTool`/`browserToolTarget` in `main/index.ts`),
and clears it on `Stop`. The renderer shows a 🌐 badge with the action. This needs
no Chrome connection at all — it's read straight from the hook stream.

**Roadmap: visual tab mirror.**

`claude --chrome` drives Chrome through the Claude-in-Chrome extension over a
native-messaging host using the Chrome DevTools Protocol (CDP). The plan:

1. Attach the app to the same Chrome over CDP and use `Page.startScreencast` to
   mirror the driven tab(s) into a pane, optionally forwarding input.
2. Tie each mirrored tab to the **session** driving it (correlating via the
   session's MCP/browser activity).

**Open risk:** CDP generally allows one debugging client per target. If the
Claude-in-Chrome extension holds that connection, the app may contend for it. The
fallback is tab metadata (URL/title) + periodic screenshots, which is low-risk.
Validate the screencast path before committing to it.

## Extending

- **Add a status source:** handle a new event in `handleHookEvent` and add the
  event name to `EVENTS` in `hooks-install.ts`.
- **Add UI:** the renderer only depends on `shared/types.ts` + `window.cockpit`.
  Add a method to `CockpitApi`, implement it in `preload/index.ts` + an IPC handler
  in `main/index.ts`.
- **Change the terminal:** `TerminalView.tsx` is self-contained; swap themes,
  fonts, or addons there.
