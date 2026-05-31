# CLAUDE.md — working on claude-cockpit

This file orients a Claude Code session that is working on **claude-cockpit itself**
(the "Cockpit Dev" session opens here automatically).

## What this app is

An Electron desktop app that houses multiple Claude Code terminal sessions in one
window, with a side panel showing each session's live status (idle / working /
waiting), sub-agent counts, and a 🌐 indicator when a session is driving Chrome.
It embeds the real `claude` TUI per pane (node-pty + xterm.js) and observes state
out-of-band via Claude Code hooks + transcript watching — it does **not**
reimplement Claude Code.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design. Key files:

- `src/main/index.ts` — app lifecycle, window, IPC, hook→status mapping, dev
  session, relaunch.
- `src/main/sessions.ts` — `SessionManager`: ptys + `TerminalSession` state +
  persistence/restore.
- `src/main/ingest.ts` — localhost HTTP server that Claude hooks POST to.
- `src/main/transcripts.ts` — sub-agent counting from `~/.claude/projects/*.jsonl`.
- `src/main/store.ts` — JSON persistence (names + open panes).
- `src/preload/index.ts` — the `window.cockpit` bridge.
- `src/renderer/src/` — React UI (`App.tsx`, `components/Sidebar.tsx`,
  `components/TerminalView.tsx`).
- `src/shared/types.ts` — the main↔renderer contract; **change this first** when
  adding a feature.
- `hooks/emit.mjs` — the hook handler Claude runs; POSTs events to the app.

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
```

## How "rebuild & relaunch" works

The app persists every open pane (name, cwd, command, Claude `session_id`) to its
userData store on each change. `relaunchApp()` (in `src/main/index.ts`) rebuilds
and relaunches; on boot `SessionManager.restore()` respawns panes, using
`claude --resume <id>` to bring back conversations. Self-relaunch only runs in the
packaged build; under `npm run dev` the harness hot-restarts on file changes.

## Git / GitHub

Public repo: `failurite/claude-cockpit` (origin, branch `main`). Commit with clear
messages; push when asked. Run the build before committing.

## Roadmap (see README)

Live Chrome **tab mirror** via CDP `Page.startScreencast` is the next big feature;
the activity *indicator* already exists. Other items: split/grid layout, packaged
signed macOS build, Windows/Linux.
