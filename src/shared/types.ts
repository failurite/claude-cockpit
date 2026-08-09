// Shared type contract between the Electron main process and the renderer.

/** High-level state of a Claude session, derived from hooks + transcript. */
export type SessionStatus =
  | 'starting' // pty spawned, no signal yet
  | 'idle' // finished a turn, nothing pending (Stop / idle_prompt)
  | 'working' // actively running tools (PreToolUse seen, no Stop yet)
  | 'waiting' // needs the user: permission prompt or a question
  | 'exited' // the pty process ended

/** Launch options that map to `claude` CLI flags for a session. */
export interface SessionOptions {
  /** `--dangerously-skip-permissions` */
  dangerouslySkipPermissions: boolean
  /** Give the session a browser. Embedded (in-Cockpit) by default; see `externalChrome`. */
  chrome: boolean
  /**
   * Use real external Chrome (`--chrome` / claude-in-chrome) instead of Cockpit's
   * embedded browser. Off by default — sessions are self-contained unless you
   * opt into external Chrome via the advanced startup config.
   */
  externalChrome: boolean
  /** Extra raw args appended verbatim to the claude command (e.g. "--model opus"). */
  extraArgs: string
}

/** Baseline options for a brand-new workspace / session: browser on, embedded. */
export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
  dangerouslySkipPermissions: true,
  chrome: true,
  externalChrome: false,
  extraArgs: ''
}

/**
 * Id of the built-in "Cockpit" workspace (the app's own repo). It's synthesized
 * by main — present by default, not stored, not editable/deletable; hidden via
 * the `hideCockpitWorkspace` setting.
 */
export const COCKPIT_WORKSPACE_ID = 'cockpit'

/** A workspace = a directory + the default launch options for sessions opened in it. */
export interface Workspace {
  /** Stable id (assigned on create). */
  id: string
  /** Display label; defaults to the folder basename. */
  name: string
  /** Absolute directory that sessions in this workspace open in. */
  path: string
  /** Defaults applied to new sessions here (overridable per session). */
  defaults: SessionOptions
}

/** One terminal pane = one Claude (or shell) process owned by the app. */
export interface TerminalSession {
  /** Stable app-side id for the pane (assigned at spawn, survives Claude session restarts). */
  id: string
  /** User-assigned label (rename target). Defaults to e.g. "Session 1". */
  name: string
  /** Working directory the pty was spawned in. */
  cwd: string
  /** The base command spawned (e.g. "claude"); flags are derived from `options`. */
  command: string
  /** 'dev' = the special session that works on claude-cockpit itself; 'normal' = everything else. */
  kind: 'normal' | 'dev'
  /** Workspace this session belongs to (null for the dev session or ad-hoc sessions). */
  workspaceId: string | null
  /** Launch options this session was created with (drives the claude command). */
  options: SessionOptions
  /** tmux session name backing this pane (dev session, when tmux is available), else null. */
  tmuxSession: string | null
  /** The GitHub issue this session is dedicated to (null for normal sessions). */
  issue: IssueRef | null
  /** Claude Code's own sessionId, once we learn it from a hook/transcript. May be null for plain shells. */
  claudeSessionId: string | null
  status: SessionStatus
  /** Count of currently-active sub-agents (Task tool / sidechains). */
  subagentCount: number
  /**
   * Cumulative tokens for this session's current conversation (input + output +
   * cache-creation, from the transcript's per-turn `usage`). Drives the live
   * token meter; cache-read tokens are excluded (cheap and dominate every turn).
   */
  tokensTotal: number
  /** Concrete model id of the latest assistant turn (e.g. `claude-opus-4-8`), or null before any turn. */
  model: string | null
  /** True while this session is actively driving Chrome (claude-in-chrome MCP tools). */
  usingChrome: boolean
  /** Most recent browser action target (e.g. host or tool), shown when usingChrome. */
  chromeActivity: string | null
  /** Last status-changing event label, for the UI subtitle. */
  lastActivity: string
  /** ms epoch of last update (stamped in main). */
  updatedAt: number
}

/**
 * A point-in-time snapshot of machine + Claude token load, sampled in main and
 * pushed to the renderer for the sidebar meters. CPU/memory are system-wide;
 * token figures are aggregated across this app's live sessions.
 */
export interface SystemStats {
  /** System-wide CPU utilisation, 0–100. */
  cpu: number
  /** System memory in use, 0–100. */
  memPercent: number
  /** System memory used / total, bytes. */
  memUsed: number
  memTotal: number
  /** Recent token throughput across live sessions, tokens/sec (smoothed). */
  tokenRate: number
  /** Cumulative tokens across all live sessions' current conversations. */
  tokensTotal: number
}

/** The account's usage/limits page — the authoritative quota lives here, not in any API. */
export const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage'

/**
 * A session that was *archived* — closed (pty killed, pane removed) but saved so
 * it can be reopened later with its Claude conversation (`--resume`) and embedded
 * browser tabs intact. This is the renderer-facing summary; the full launch record
 * lives in the main-process store.
 */
export interface ArchivedSessionInfo {
  /** Stable id for this archived record (reopen / delete target). */
  archivedId: string
  name: string
  /** Workspace it belonged to (null for ad-hoc sessions). */
  workspaceId: string | null
  kind: 'normal' | 'dev'
  /** Issue number if this was an issue-dedicated session, for the #n chip. */
  issueNumber: number | null
  /** True when there's a Claude conversation to resume on reopen. */
  hasConversation: boolean
  /** How many embedded-browser tabs will reopen with it. */
  tabCount: number
  /** ms epoch when it was archived. */
  archivedAt: number
}

/** A label defined on a repo (for the New-issue label picker). */
export interface RepoLabel {
  name: string
  /** Hex color (no leading #), or '' if unknown. */
  color: string
  description: string
}

/** A GitHub issue as listed in a workspace's Issues panel (via the gh CLI). */
export interface IssueSummary {
  number: number
  title: string
  url: string
  labels: string[]
  updatedAt: string
}

/** The issue a session is dedicated to, with its isolation worktree + branch. */
export interface IssueRef {
  number: number
  title: string
  url: string
  /** Branch the work happens on, e.g. "issue/42-fix-login". */
  branch: string
  /** Absolute path of the session's isolated git worktree. */
  worktree: string
  /** The workspace's main checkout this issue belongs to. */
  repoDir: string
}

/** Outcome of the Done flow for an issue session. */
export interface IssueDoneResult {
  ok: boolean
  /** merged = landed on the default branch; dirty/conflict = sent back to the session. */
  status: 'merged' | 'dirty' | 'conflict' | 'error'
  message: string
  /** One-line-per-commit summary of what was merged (when status = merged). */
  summary?: string
}

/** Git state of a workspace directory, for the sidebar push/pull UI. */
export interface GitStatus {
  /** False if the directory isn't a git work tree. */
  isRepo: boolean
  /** Current branch (or null if detached/unknown). */
  branch: string | null
  /** Tracking branch, e.g. "origin/main" (null if none configured). */
  upstream: string | null
  /** Commits ahead of upstream (unpushed). */
  ahead: number
  /** Commits behind upstream (unpulled — only fresh after a fetch). */
  behind: number
  /** True if there are uncommitted changes. */
  dirty: boolean
  /** origin's URL, if any. */
  remoteUrl: string | null
  /** Set if a git command failed unexpectedly. */
  error?: string
}

/** One tab in a session's embedded browser (Cockpit-owned WebContentsView). */
export interface BrowserTab {
  /** Stable id for the tab within its pane. */
  id: string
  /** Current document title (or the URL until one loads). */
  title: string
  /** Current URL. */
  url: string
  /** True while a navigation is in flight. */
  loading: boolean
  /** True if this is the pane's foreground tab. */
  active: boolean
}

/** On-screen rectangle (CSS px, relative to the window content) for the browser overlay. */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Event posted by a Claude Code hook to the local ingest server. */
export interface HookEvent {
  hook_event_name: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  notification_type?: string
  matcher?: string
  // The app injects this from the hook command so we can map hook->pane
  // even before we know Claude's session_id.
  cockpit_pane_id?: string
  [k: string]: unknown
}

/** Lifecycle of an auto-update check/download (electron-updater). */
export type UpdateState =
  | 'idle' // nothing happening yet
  | 'checking' // querying the feed
  | 'available' // a newer version exists (downloading begins automatically)
  | 'not-available' // already up to date
  | 'downloading' // pulling the update (see `percent`)
  | 'downloaded' // ready to install on restart
  | 'error' // the check/download failed (see `message`)
  | 'unsupported' // dev build or unsigned app — auto-update can't run here

/** Current auto-update status, broadcast to the renderer as it changes. */
export interface UpdateStatus {
  state: UpdateState
  /** The available/downloaded version, when known. */
  version: string | null
  /** Download progress 0–100 while `state === 'downloading'`. */
  percent: number | null
  /** Human-readable detail (error text, or why it's unsupported). */
  message: string | null
}

/** The API surface exposed to the renderer via the preload bridge. */
export interface CockpitApi {
  listSessions(): Promise<TerminalSession[]>
  /**
   * Spawn a session. In a workspace, pass `workspaceId` (cwd + defaults are
   * resolved from it); `options` overrides those defaults for this session.
   * For an ad-hoc session pass `cwd` (and optionally `options`) directly.
   */
  createSession(opts?: {
    workspaceId?: string | null
    cwd?: string
    command?: string
    name?: string
    options?: Partial<SessionOptions>
  }): Promise<TerminalSession>
  /** Spawn the special "work on claude-cockpit itself" session in the app's own repo. */
  createDevSession(): Promise<TerminalSession>
  /** Native folder picker; returns the chosen absolute path or null if cancelled. */
  pickFolder(): Promise<string | null>
  /** Workspace management (directory + default launch options). */
  workspaces: {
    list(): Promise<Workspace[]>
    /** Create or update a workspace (upsert by id); returns the full list. */
    save(ws: Workspace): Promise<Workspace[]>
    /**
     * Clone a GitHub repo into `dir` (or `~/<repo-name>` if omitted) and create a
     * workspace pointed at the clone. Returns the updated list + new workspace on
     * success, or `ok:false` + a message (bad URL, private repo, folder exists).
     */
    createFromRepo(opts: {
      url: string
      dir?: string
      name?: string
      defaults: SessionOptions
    }): Promise<{ ok: boolean; message?: string; workspaces: Workspace[]; workspace?: Workspace }>
    /**
     * Create a new GitHub repo (private/public) under the authenticated account
     * via `gh repo create`, clone it into `parentDir/<name>`, and make a workspace
     * for it. Returns `ok:false` + a message on failure (not authed, name taken).
     */
    createRepo(opts: {
      name: string
      private: boolean
      parentDir?: string
      description?: string
      workspaceName?: string
      defaults: SessionOptions
    }): Promise<{ ok: boolean; message?: string; workspaces: Workspace[]; workspace?: Workspace }>
    /**
     * Rename a workspace's GitHub repo via `gh repo rename` (renames on GitHub +
     * updates its `origin`), following the workspace label when it was the default.
     * When `renameFolder` is true, also move the local folder to match and re-point
     * the workspace + its live sessions. Returns the updated list (always) and
     * `ok:false` + message on failure.
     */
    renameRepo(
      workspaceId: string,
      newName: string,
      renameFolder: boolean
    ): Promise<{ ok: boolean; message?: string; workspaces: Workspace[] }>
    /** Reorder user workspaces to match the given id order; returns the full list. */
    reorder(orderedIds: string[]): Promise<Workspace[]>
    /** Remove a workspace by id; returns the remaining list. */
    remove(id: string): Promise<Workspace[]>
  }
  /** Reorder a workspace's sessions (its session ids in the new order). */
  reorderSessions(orderedIds: string[]): void
  closeSession(id: string): Promise<void>
  /**
   * Relaunch a session's claude process in place (same pane + position),
   * resuming its conversation so state is retained. Returns the updated session,
   * or null if it can't be restarted (e.g. the dev session). Handy to pick up a
   * newly-available model without losing the conversation.
   */
  restartSession(id: string): Promise<TerminalSession | null>
  /** Close every session (kills all ptys) and kill all cockpit tmux; returns remaining tmux names. */
  closeAllSessions(): Promise<string[]>
  /** Archive a session: close it but save its conversation + browser tabs to reopen later. Returns the updated archived list. */
  archiveSession(id: string): Promise<ArchivedSessionInfo[]>
  /** List archived (closed-and-saved) sessions. */
  archivedSessions(): Promise<ArchivedSessionInfo[]>
  /** Reopen an archived session (claude --resume + reopen its tabs); returns the new pane, or null if the record is gone. */
  restoreArchivedSession(archivedId: string): Promise<TerminalSession | null>
  /** Permanently delete an archived session record. Returns the updated archived list. */
  deleteArchivedSession(archivedId: string): Promise<ArchivedSessionInfo[]>
  renameSession(id: string, name: string): Promise<void>
  /**
   * Switch a session's model by driving `/model <arg>` in its pty. `arg` is a
   * Claude Code model alias (`opus`/`sonnet`/`haiku`/`default`/…) or a `claude-*`
   * id. `session.model` updates once the next assistant turn lands.
   */
  setSessionModel(id: string, arg: string): void
  /** Send user keystrokes/data into a pty. */
  write(id: string, data: string): void
  /** Notify main that the xterm view resized. */
  resize(id: string, cols: number, rows: number): void
  /** Subscribe to pty output for a pane. Returns an unsubscribe fn. */
  onData(id: string, cb: (data: string) => void): () => void
  /** Fires when a pane's pty was relaunched (restart) — the view should clear. */
  onReset(id: string, cb: () => void): () => void
  /** Get pty output captured before the view mounted (replay), then onData for live. */
  attach(id: string): Promise<string>
  /** Subscribe to session-list changes (status, names, subagents, add/remove). */
  onSessionsChanged(cb: (sessions: TerminalSession[]) => void): () => void
  /** Subscribe to periodic system + token-load stats (for the sidebar meters). */
  onSystemStats(cb: (stats: SystemStats) => void): () => void
  /** Main asks the renderer to re-focus the active terminal (e.g. after agent-driven
   *  browser activity grabbed OS focus). Returns an unsubscribe fn. */
  onRefocusTerminal(cb: () => void): () => void
  /** Status-hook install management against ~/.claude/settings.json. */
  hooks: {
    status(): Promise<HookInstallState>
    install(): Promise<HookInstallState>
    uninstall(): Promise<HookInstallState>
  }
  /** Info about the app itself (e.g. whether the dev repo is available, repo path). */
  appInfo(): Promise<AppInfo>
  /** Open an https URL in the system browser (e.g. an issue on GitHub). */
  openExternal(url: string): void
  /** Persist state and relaunch the app, optionally rebuilding first. Restores sessions on boot. */
  relaunchApp(opts?: { rebuild?: boolean }): Promise<{ ok: boolean; message?: string }>
  /** Visibility + cleanup for cockpit-owned tmux sessions (avoids rogue background sessions). */
  tmux: {
    /** Whether tmux is installed (dev session gets true process persistence when so). */
    available(): Promise<boolean>
    /** Names of currently-live cockpit-owned tmux sessions. */
    list(): Promise<string[]>
    /** Kill one cockpit tmux session by name; returns the remaining list. */
    kill(name: string): Promise<string[]>
  }
  /** Per-session embedded browser (replaces external Chrome for normal sessions). */
  browser: {
    /** Tabs currently open in a pane's browser. */
    listTabs(paneId: string): Promise<BrowserTab[]>
    /** Open a new tab (optionally at a URL) and make it active; returns the tab. */
    openTab(paneId: string, url?: string): Promise<BrowserTab>
    /** Close a tab; returns the remaining tabs. */
    closeTab(paneId: string, tabId: string): Promise<BrowserTab[]>
    /** Make a tab the foreground tab for its pane. */
    activateTab(paneId: string, tabId: string): Promise<BrowserTab[]>
    /** Navigate a tab (defaults to the active tab) to a URL. */
    navigate(paneId: string, tabId: string, url: string): Promise<void>
    /** Report where the active tab should render for a pane (null = nowhere). */
    setBounds(paneId: string, bounds: BrowserBounds | null): void
    /** Show or hide a pane's browser overlay (only one pane is foreground at a time). */
    setVisible(paneId: string, visible: boolean): void
    /**
     * Force-hide every browser overlay (true) or resume normal layout (false).
     * Used while an app-level modal is open, since the native overlay would
     * otherwise paint over it.
     */
    setOverlaySuppressed(suppressed: boolean): void
    /** Subscribe to tab-list changes for any pane. Returns an unsubscribe fn. */
    onTabsChanged(cb: (paneId: string, tabs: BrowserTab[]) => void): () => void
  }
  /** GitHub issues per workspace + issue-dedicated sessions (gh CLI). */
  issues: {
    /** True if the gh CLI is installed and authenticated for this repo. */
    available(dir: string): Promise<boolean>
    /** Open issues for the repo at `dir`. */
    list(dir: string): Promise<IssueSummary[]>
    /** Full detail (body included) for one issue — for previewing before starting a session. */
    view(dir: string, number: number): Promise<{ number: number; title: string; body: string; url: string }>
    /** Create an isolated worktree + branch for an issue and spawn a session in it. */
    start(workspaceId: string, number: number): Promise<TerminalSession>
    /** Finish an issue session: rebase → merge to default branch → push → close issue. */
    done(paneId: string): Promise<IssueDoneResult>
    /** Labels defined on the repo (for the New-issue picker). */
    labels(dir: string): Promise<RepoLabel[]>
    /** Create a new issue; returns its URL on success. */
    create(
      dir: string,
      opts: { title: string; body: string; labels: string[] }
    ): Promise<{ ok: boolean; url?: string; message?: string }>
    /** Upload a pasted image to GitHub and return a URL to embed in an issue body. */
    uploadImage(
      dir: string,
      opts: { name: string; contentType: string; dataBase64: string }
    ): Promise<{ ok: boolean; url?: string; message?: string }>
  }
  /** Git status + push/pull for a workspace directory. */
  git: {
    /** Snapshot a directory's git state. `fetch` updates the unpulled count (network). */
    status(dir: string, fetch?: boolean): Promise<GitStatus>
    push(dir: string): Promise<{ ok: boolean; message: string }>
    pull(dir: string): Promise<{ ok: boolean; message: string }>
  }
  /** App-wide settings. */
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  /** Auto-update (electron-updater) against the GitHub Releases feed. */
  updates: {
    /** The latest known status (no network call). */
    status(): Promise<UpdateStatus>
    /** Trigger a check now; resolves with the resulting status. */
    check(): Promise<UpdateStatus>
    /** Quit and install a downloaded update (only valid when state === 'downloaded'). */
    install(): Promise<void>
    /** Subscribe to status changes. Returns an unsubscribe fn. */
    onStatus(cb: (s: UpdateStatus) => void): () => void
    /**
     * True if a locally-built update (`npm run update-app`) has been swapped in
     * on disk and is waiting for a restart to take effect. Lets the renderer
     * re-show the "Restart to update" button if the staged event fired before it
     * mounted.
     */
    stagedPending(): Promise<boolean>
    /** Relaunch into the staged local build (quits and reopens the new app). */
    applyStaged(): void
    /** Fires when a locally-built update has just been staged and is ready to apply. */
    onStaged(cb: () => void): () => void
  }
}

export interface AppSettings {
  /** Kill cockpit-owned tmux sessions when the app fully quits (default false — survival is the point). */
  killTmuxOnQuit: boolean
  /** Hide the built-in "Cockpit" workspace (the app's own repo) from the sidebar. */
  hideCockpitWorkspace: boolean
  /**
   * Back every claude session with a persistent tmux session so its process (and
   * live state) survives an app restart (macOS/Linux; default true). Off = fall
   * back to `claude --resume` (conversation restores, process is fresh). The dev
   * session always persists regardless.
   */
  keepSessionsAlive: boolean
}

export interface AppInfo {
  /** The app's own version (from package.json), shown in Settings. */
  version: string
  /** Absolute path to the claude-cockpit repo (where the dev session opens). */
  repoRoot: string
  /** True if that path looks like the app's source checkout (has package.json + src). */
  devAvailable: boolean
  /** True when running the dev server (npm run dev) vs a packaged build. */
  isDev: boolean
  /** True only on the launch where the app auto-installed status hooks (drives a one-time notice). */
  hooksJustInstalled: boolean
}

export interface HookInstallState {
  installed: boolean
  command: string | null
}
