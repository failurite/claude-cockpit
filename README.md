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
- **Archive & reopen sessions** — for sessions you only use occasionally, 📦
  archive one to close it but save it; reopen it later from the workspace's
  **Archived** list with its conversation (`claude --resume`) and browser tabs
  intact.
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
- **Archive a session** with the 📦 button to close it but keep it: the pty is
  killed and the pane removed, but its launch record — Claude `session_id` and
  embedded-browser tab URLs — is saved. Each workspace gains a collapsible
  **Archived** list where you can ▶ reopen one (respawned with `claude --resume`
  and its tabs reopened, logins intact via the persistent profile) or × forget it.
  Archived sessions survive restarts and are *not* auto-opened on boot.

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
  session gets the issue body as kickoff context, and is told to plan first, then
  **validate the fix itself** before calling it ready (run build/tests, and for a
  web app open it in the embedded browser to visually inspect) and leave it **open
  for interactive review** — surfacing the running result, or asking you how you'd
  like to validate when that isn't obvious.
- Work **multiple issues concurrently**: worktrees mean sessions never touch each
  other's files; the main checkout stays clean.
- **✓ Done** (status bar) lands the work: rebase onto the default branch → merge +
  push → close the issue with a commit-summary comment → remove the worktree and
  retire the session, then **refresh the Issues list** so the closed issue drops
  off. Finishes are **serialized** so main never races. If the worktree is dirty
  or the rebase conflicts, Cockpit hands the fix to that session — for a conflict
  it directs Claude to **resolve the paused rebase, re-validate, and load the app
  up for you to test interactively** (since merging can change behavior) — then
  you press Done again (which safely detects an unfinished rebase rather than
  restarting it).

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

Requirements: macOS or **Windows** (experimental — see below), Node 20+, and
`claude` on your `PATH`. On macOS `tmux` (`brew install tmux`) is optional but
recommended for a process-persistent dev session; Windows has no tmux and falls
back to `claude --resume` on restart.

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
then add sessions to it. The folder is optional — you can create a workspace for
new work before you have a directory or GitHub repo (its sessions start in your
home directory until you set a folder via **Edit workspace…**). Each workspace
shows its folder on disk beneath its name. Double-click a workspace **or** a
session name to rename it in place.

### Install as a standalone app (recommended)

Run it from a Desktop icon instead of `npm run dev`, so it no longer dies when you
exit a Claude session:

```bash
npm run update-app    # build + install the app to your Desktop, then launch it
```

`update-app` is cross-platform: it runs `scripts/install-local.sh` on macOS and
`scripts/install-local.ps1` on Windows (both build, swap the installed app in
place, and relaunch). Double-click **Claude Cockpit** on your Desktop. (Install
elsewhere with `COCKPIT_APP_PATH=...`.)

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

> **Distributing to other machines / both platforms?** Push a version tag
> (`git tag v0.2.0 && git push origin v0.2.0`) and the
> [`Release` workflow](.github/workflows/release.yml) builds **macOS *and* Windows
> from the same commit** on GitHub-hosted runners and publishes both to a GitHub
> Release. This is what guarantees a feature authored on either OS reaches both
> platform releases — `update-app` only ever builds the machine it runs on. The
> running app then auto-updates from that feed (`src/main/updater.ts`). Windows
> ships **unsigned** for now (SmartScreen warns on first run → *More info → Run
> anyway*); set the `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
> repo secrets to get a notarized, auto-updating macOS build from CI too.

### Windows (experimental)

Windows support is new and best-effort. Requirements: Node 20+, `claude` on your
`PATH`, and **`node` reachable on `PATH`** (Cockpit's status hooks and MCP shims
run as `node …`). The dev session runs without tmux (no process-persistence across
restarts; conversations restore via `claude --resume`). Install the latest
(unsigned) build from [Releases](https://github.com/failurite/claude-cockpit/releases),
or build locally with `npm run update-app`. Please report rough edges.

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
- [~] **Windows support** (experimental) — platform abstraction for the pane shell,
      cross-platform `update-app`, and a CI matrix that ships mac + Windows from one
      commit. Linux still untested.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — process model, IPC, status
  pipeline, embedded browser, git, and how to extend it.
- [docs/HOOKS.md](docs/HOOKS.md) — what gets written to your Claude settings, and
  how to install/remove it.
- [CLAUDE.md](CLAUDE.md) — orientation for a Claude Code session working on Cockpit.
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup and where things live.

## License

MIT — see [LICENSE](LICENSE).
