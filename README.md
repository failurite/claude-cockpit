# claude-cockpit

A single, full-screen home for all your [Claude Code](https://claude.com/claude-code) sessions.

If you run several Claude Code terminals at once — one fixing a bug, one writing
docs, one driving a browser — `claude-cockpit` houses them in one window with a
side panel that shows, at a glance, **what each session is doing**: idle, working,
or waiting for you. Each pane is a real terminal running the actual Claude Code
TUI, so nothing about your workflow changes.

> **Status:** early but working. Multi-session terminal grid, live status, naming,
> and sub-agent counts are implemented. Linked Chrome-tab views are on the
> [roadmap](#roadmap).

---

## Why this exists

Claude Code is a terminal app. Power users end up with a pile of terminal tabs and
no way to tell which session is blocked on a question, which is grinding through
work, and which is done. `claude-cockpit` gives you:

- **One window, many sessions** — a terminal grid you can full-screen, instead of
  scattered terminal tabs on a small screen.
- **Live status per session** — a colored dot tells you whether each session is
  `working`, `idle`, or `waiting` for your input/permission.
- **Names you control** — rename any session (double-click it) so "Session 3"
  becomes "auth refactor". Names persist.
- **Sub-agent counts** — see how many sub-agents (Task tool / sidechains) a
  session currently has running.
- **Chrome activity indicator** — when a session uses `claude --chrome`, a 🌐
  badge lights up in real time (with the action, e.g. `navigate github.com`) so
  you can see which session is driving the browser right now.
- **(Roadmap) Linked Chrome tab views** — mirror the actual tabs a session is
  driving, tied to the session driving them.

## How it works

`claude-cockpit` is an Electron app. It does **not** reimplement Claude Code — it
embeds the real thing and observes it through Claude Code's own extension points.

```
┌───────────────────────────── Electron main ─────────────────────────────┐
│  SessionManager ── spawns `claude` in a real PTY (node-pty) per pane      │
│        │                                                                  │
│        ├── pty output ──────────────► renderer (xterm.js terminal view)   │
│        │                                                                  │
│  Ingest HTTP server (127.0.0.1) ◄──── Claude Code hooks (emit.mjs)        │
│        │   Notification / Stop / PreToolUse / … → status per session      │
│        │                                                                  │
│  Transcript watcher ── tails ~/.claude/projects/<id>.jsonl                │
│            counts active `Task` sub-agents (isSidechain)                  │
└──────────────────────────────────────────────────────────────────────────┘
```

Two independent signals drive the status panel:

1. **Hooks (primary).** A tiny hook script (`hooks/emit.mjs`) is registered in
   `~/.claude/settings.json`. Claude Code runs it on lifecycle events and it POSTs
   the event to a local server inside the app. Each terminal exports a
   `CLAUDE_COCKPIT_PANE_ID`, which the hook inherits — so the app knows exactly
   which pane fired, and learns Claude's own `session_id` from the payload.

   | Hook event | Shown as |
   | --- | --- |
   | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | **working** |
   | `Notification` (permission / elicitation) | **waiting** (needs you) |
   | `Notification` (idle prompt), `Stop` | **idle** |
   | `PreToolUse` with an `mcp__*chrome*` tool | **🌐 driving Chrome** |
   | `SessionStart` / `SessionEnd` | started / ended |

   Chrome detection works because `claude --chrome` drives the browser through
   `claude-in-chrome` MCP tools (`mcp__claude-in-chrome__navigate`, …). Those
   surface in `PreToolUse` as the `tool_name`, so the app flags the session as
   actively browsing without needing any Chrome connection. The flag clears when
   the turn ends (`Stop`).

2. **Transcript watcher (sub-agents).** The app tails the session's JSONL
   transcript under `~/.claude/projects/` and counts `Task` tool calls that
   haven't returned yet — i.e. sub-agents currently running. (Heuristic, v1.)

Status detection is deliberately **out-of-band** — the app never scrapes terminal
output to guess state, which is fragile. It reads Claude Code's documented signals.

## Install & run (development)

Requirements: macOS, Node 20+, and `claude` on your `PATH`.

```bash
git clone https://github.com/failurite/claude-cockpit.git
cd claude-cockpit
npm install
npm run dev        # launches the app with hot reload
```

On first launch, click **Install status hooks** in the banner. This adds
`claude-cockpit`'s hook command to `~/.claude/settings.json` (a backup is written
to `settings.json.claude-cockpit.bak` first). Without it, sessions still run — you
just won't get live status. You can remove the hooks any time (see
[docs/HOOKS.md](docs/HOOKS.md)).

Then hit **+ New Claude session**. Double-click a session in the sidebar to rename
it.

### Build a standalone app

```bash
npm run build      # bundles main + preload + renderer into out/
npm start          # preview the production build
```

## Roadmap

- [x] **Chrome activity detection.** Show which session is driving Chrome right
      now (via `claude-in-chrome` MCP tool calls in hooks). _Done._
- [ ] **Linked Chrome tab views.** Mirror the tabs a `claude --chrome` session is
      driving, via CDP `Page.startScreencast`, tied to the driving session. See
      [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#chrome-integration) for the plan
      and the open feasibility question (CDP client contention).
- [ ] Split-view / grid layout (more than one terminal visible at once).
- [ ] Per-session working-directory picker and command presets.
- [ ] Packaged, signed macOS build + auto-update.
- [ ] Windows/Linux support (the stack is cross-platform; just untested).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — process model, IPC, status
  pipeline, and how to extend it.
- [docs/HOOKS.md](docs/HOOKS.md) — what gets written to your Claude settings, and
  how to install/remove it.
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup and where things live.

## License

MIT — see [LICENSE](LICENSE).
