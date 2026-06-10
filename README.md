# claude-cockpit

A single, full-screen home for all your [Claude Code](https://claude.com/claude-code) sessions.

If you run several Claude Code terminals at once — one fixing a bug, one writing
docs, one driving a browser — `claude-cockpit` houses them in one window with a
side panel that shows, at a glance, **what each session is doing**: idle, working,
or waiting for you. Each pane is a real terminal running the actual Claude Code
TUI, so nothing about your workflow changes — plus an **embedded browser per
session** that Claude drives *inside* the app instead of opening external Chrome.

> **Status:** working daily-driver. Multi-session terminals, live status,
> workspaces, session persistence/restore, a tmux-backed dev session, an embedded
> per-session browser, and per-workspace git push/pull are all implemented.

---

## Why this exists

Claude Code is a terminal app. Power users end up with a pile of terminal tabs and
no way to tell which session is blocked on a question, which is grinding through
work, and which is done. `claude-cockpit` gives you:

- **One window, many sessions** — a terminal grid you can full-screen, instead of
  scattered terminal tabs.
- **Live status per session** — a colored dot shows whether each session is
  `working`, `idle`, `waiting` for you, or `exited`, plus the last activity.
- **Workspaces** — group sessions by project folder, each with its own default
  launch options (`--dangerously-skip-permissions`, browser on/off, extra args).
- **Names you control** — double-click a session to rename it; names persist.
- **Sub-agent counts** — see how many sub-agents (Task tool / sidechains) a
  session currently has running.
- **Embedded browser per session** — when a session has the browser enabled,
  Claude opens and drives tabs *inside Cockpit* (not an external Chrome window),
  with a tab strip, URL bar, persistent login profile, and tabs that survive
  restarts. External Chrome is still available as an opt-in.
- **Cross-session awareness** — a session can list its sibling sessions and read
  a digest of another's context (recent prompts, progress, files it's editing) to
  coordinate on related bugs, via a Cockpit-owned MCP server.
- **Per-workspace git** — branch, ↑unpushed / ↓unpulled counts, a dirty marker,
  and manual Pull / Push right in the sidebar.
- **Persistence & restore** — close and reopen Cockpit and your sessions come
  back, resuming conversations via `claude --resume`; the dev session keeps its
  live process via tmux.

## Features

### Sessions & workspaces
- Each pane is the **real Claude Code TUI** in a `node-pty` pseudo-terminal —
  full color/resize/`Ctrl-C` fidelity.
- **Workspaces** = a directory + default `SessionOptions`. The `+` in a workspace
  header opens a session with those defaults; the `▾` menu opens a custom-settings
  dialog (the advanced startup config) where you can override options per session.
- **Restore on launch:** every open pane (name, cwd, command, options, Claude
  `session_id`, and its browser tabs) is persisted; on boot Cockpit respawns them,
  using `claude --resume <id>` to bring conversations back.
- **Close all sessions** (Settings → Sessions) shuts every pane down and sweeps
  any lingering cockpit-owned tmux sessions.

### The built-in "Cockpit" workspace
- Cockpit's own repo appears as a **first-class workspace named "Cockpit"** —
  present by default on a fresh install, with the same git row, issues list, and
  session controls as any workspace. Hide it via Settings → Sessions if you
  don't hack on the app. It can't be edited/deleted (it's synthesized, not stored).
- Its **"Cockpit Dev" session opens automatically** so you can always work on the
  app itself. When `tmux` is installed that session runs inside a **persistent
  tmux session**, so the real `claude` process survives app restarts (Cockpit just
  re-attaches). Without tmux it falls back to `claude --resume` (conversation
  persists, process restarts).

### Live status (out-of-band)
- Status comes from **Claude Code hooks**, never from scraping the terminal. A tiny
  hook script POSTs lifecycle events to a localhost server in the app.

  | Hook event | Shown as |
  | --- | --- |
  | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | **working** |
  | `Notification` (permission / elicitation) | **waiting** (needs you) |
  | `Notification` (idle), `Stop` | **idle** |
  | a browser MCP tool in `PreToolUse` | **🌐 driving the browser** |
  | `SessionStart` / `SessionEnd` | started / ended |

- A **transcript watcher** tails the session's JSONL and counts running `Task`
  sub-agents.

### Embedded browser
- With the browser enabled (the default), a session launches with
  `--mcp-config <cockpit-browser>` instead of `--chrome`. Claude gets tools
  (`browser_open_tab`, `navigate`, `click`, `type`, `read_text`, `screenshot`,
  `list_tabs`, `close_tab`) that drive **`WebContentsView` tabs rendered inside the
  Cockpit window** — no external Chrome.
- **Persistent login profile:** all embedded tabs share one persistent profile, so
  you sign into a site once and stay logged in across tabs, sessions, and restarts.
  (Cockpit never imports Chrome's saved passwords — embedded Chromium has no Chrome
  password manager, and that store is OS-keychain encrypted.)
- **Tab persistence:** open tabs are restored on the next launch (logged in, via
  the persistent profile).
- **External Chrome opt-in:** tick *"Use external Chrome instead"* in the advanced
  startup config to use real Chrome / `claude-in-chrome` for that session.

### Cross-session awareness
- Every normal session also launches with a second `--mcp-config
  <cockpit-sessions>`, giving Claude two read-only tools:
  - `cockpit_list_sessions` — the other open sessions, each with its workspace,
    GitHub issue/branch, working dir, live status, and sub-agent count.
  - `cockpit_read_session` — resolve a sibling by name, `#issue`, or id and read a
    digest of its context: recent human prompts, latest progress, and the files
    it has been editing.
- It's **observe-only** — a session can consult a related one to keep work
  coordinated (e.g. two linked bugs) without interrupting or messaging it. The
  digest is a bounded read of the target's transcript; nothing is scraped from the
  terminal.

### Issue-driven sessions (GitHub)
- Each workspace shows its repo's **open GitHub issues** (via the `gh` CLI —
  Cockpit reuses your existing auth, never stores tokens).
- **▶ Start** on an issue creates an **isolated git worktree + branch**
  (`issue/<n>-<slug>`) and spawns a dedicated session in it, named `#<n> <title>`
  with a `#<n>` chip — the session↔issue mapping is explicit and persisted. The
  session gets the issue body as kickoff context.
- Work **multiple issues concurrently**: worktrees mean sessions never touch each
  other's files; the main checkout stays clean.
- **✓ Done** (status bar) lands the work: rebase onto the default branch → merge +
  push → close the issue with a commit-summary comment → remove the worktree and
  retire the session. Finishes are **serialized** so main never races. If the
  worktree is dirty or the rebase conflicts, Cockpit types instructions into that
  session so its Claude fixes things, then you press Done again.

### Per-workspace git
- Each workspace (and the Dev session's repo) shows branch, ↑ahead / ↓behind, and a
  dirty marker, with **Pull / Push** and a fetch-refresh button. Git runs with
  `GIT_TERMINAL_PROMPT=0` so a credential-needing remote fails fast with a message
  instead of hanging.

## How it works

`claude-cockpit` is an Electron app. It does **not** reimplement Claude Code — it
embeds the real thing and observes/extends it through Claude Code's own extension
points (hooks, transcripts, MCP).

```
┌───────────────────────────── Electron main ─────────────────────────────┐
│  SessionManager ── spawns `claude` in a real PTY (node-pty) per pane      │
│        ├── pty output ──────────────► renderer (xterm.js terminal view)   │
│        └── persists panes (+ browser tabs) → restore on launch            │
│                                                                           │
│  Ingest HTTP server (:47615) ◄─────── Claude Code hooks (emit.mjs)        │
│        Notification / Stop / PreToolUse / … → status per session          │
│                                                                           │
│  BrowserManager ── WebContentsView tabs per pane, driven via CDP/JS       │
│  Browser RPC (:47616) ◄────────────── cockpit-browser MCP shim (per pane) │
│  Sessions RPC (:47617) ◄───────────── cockpit-sessions MCP shim (per pane)│
│        list siblings / read another session's context digest              │
│                                                                           │
│  Transcript watcher ── tails ~/.claude/projects/*.jsonl → sub-agent count │
│  git.ts ── status / push / pull per workspace dir                         │
└──────────────────────────────────────────────────────────────────────────┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Install & run (development)

Requirements: macOS, Node 20+, and `claude` on your `PATH`. `tmux`
(`brew install tmux`) is optional but recommended for a process-persistent dev
session.

```bash
git clone https://github.com/failurite/claude-cockpit.git
cd claude-cockpit
npm install
npm run dev        # launches the app with hot reload
```

Cockpit auto-installs its status hooks into `~/.claude/settings.json` on first
launch (a backup is written to `settings.json.claude-cockpit.bak` first). Without
them, sessions still run — you just won't get live status. Manage them anytime in
Settings or per [docs/HOOKS.md](docs/HOOKS.md).

Create a **workspace** (the `+` in the sidebar header) pointed at a project folder,
then add sessions to it. Double-click a session to rename it.

### Install as a standalone app (recommended)

Run it from a Desktop icon instead of `npm run dev`, so it no longer dies when you
exit a Claude session:

```bash
npm run update-app    # build + install "Claude Cockpit.app" to your Desktop, then launch it
```

Double-click **Claude Cockpit** on your Desktop. (Install elsewhere with
`COCKPIT_APP_PATH=/Applications/...`.)

> **Native module note.** `node-pty` is compiled for this Electron version during
> packaging and needs working Xcode Command Line Tools (`xcode-select --install`).
> If the build fails with `'functional' file not found`, reinstall the CLT:
> `sudo rm -rf /Library/Developer/CommandLineTools && sudo xcode-select --install`.

### Updating — all local, no GitHub, no passwords

This is a personal tool you build and run on one Mac, so updates are local:

1. Edit the code (the **Cockpit Dev** session opens right in this repo).
2. Run **`npm run update-app`**.

It rebuilds, swaps the installed app in place, and relaunches it (your open
sessions and browser tabs are restored). Because the app is built on your machine
it carries no quarantine flag, so macOS runs it with **no notarization and no
signing prompts**. Push only **source** to GitHub — build artifacts never go there.

> **Distributing to other machines?** That's the one case for the GitHub-Releases
> path: `npm run release` plus code signing + notarization, since a *downloaded*
> app is quarantined. The wiring is in `electron-builder.yml` (`publish:` + the
> `notarize` block) and `src/main/updater.ts`, dormant until you need it.

## Roadmap

- [x] **Live status** via hooks (idle / working / waiting), sub-agent counts.
- [x] **Workspaces** + per-session launch options.
- [x] **Session persistence / restore** (`claude --resume`), tmux-backed dev session.
- [x] **Embedded per-session browser** (WebContentsView + a Cockpit-owned MCP
      server), persistent login profile, tab persistence, external-Chrome opt-in.
- [x] **Cross-session awareness** — a session can list siblings and read another
      session's context digest (Cockpit-owned MCP server) to coordinate work.
- [x] **Per-workspace git** status + push/pull.
- [x] **Issue-driven sessions** — per-issue worktrees + branches, concurrent
      work, Done flow (rebase → merge → push → close issue).
- [ ] Split-view / grid layout (more than one terminal visible at once).
- [ ] Real synthetic input for the embedded browser (CDP `Input.dispatch`),
      background-tab screenshots.
- [ ] Windows/Linux support (the stack is cross-platform; just untested).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — process model, IPC, status
  pipeline, embedded browser, git, and how to extend it.
- [docs/HOOKS.md](docs/HOOKS.md) — what gets written to your Claude settings, and
  how to install/remove it.
- [CLAUDE.md](CLAUDE.md) — orientation for a Claude Code session working on Cockpit.
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup and where things live.

## License

MIT — see [LICENSE](LICENSE).
