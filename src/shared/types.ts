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
  /** `--chrome` (drive Chrome via the claude-in-chrome MCP) */
  chrome: boolean
  /** Extra raw args appended verbatim to the claude command (e.g. "--model opus"). */
  extraArgs: string
}

/** Baseline options for a brand-new workspace / session. */
export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
  dangerouslySkipPermissions: true,
  chrome: true,
  extraArgs: ''
}

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
  /** Claude Code's own sessionId, once we learn it from a hook/transcript. May be null for plain shells. */
  claudeSessionId: string | null
  status: SessionStatus
  /** Count of currently-active sub-agents (Task tool / sidechains). */
  subagentCount: number
  /** True while this session is actively driving Chrome (claude-in-chrome MCP tools). */
  usingChrome: boolean
  /** Most recent browser action target (e.g. host or tool), shown when usingChrome. */
  chromeActivity: string | null
  /** Last status-changing event label, for the UI subtitle. */
  lastActivity: string
  /** ms epoch of last update (stamped in main). */
  updatedAt: number
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
    /** Remove a workspace by id; returns the remaining list. */
    remove(id: string): Promise<Workspace[]>
  }
  closeSession(id: string): Promise<void>
  renameSession(id: string, name: string): Promise<void>
  /** Send user keystrokes/data into a pty. */
  write(id: string, data: string): void
  /** Notify main that the xterm view resized. */
  resize(id: string, cols: number, rows: number): void
  /** Subscribe to pty output for a pane. Returns an unsubscribe fn. */
  onData(id: string, cb: (data: string) => void): () => void
  /** Get pty output captured before the view mounted (replay), then onData for live. */
  attach(id: string): Promise<string>
  /** Subscribe to session-list changes (status, names, subagents, add/remove). */
  onSessionsChanged(cb: (sessions: TerminalSession[]) => void): () => void
  /** Status-hook install management against ~/.claude/settings.json. */
  hooks: {
    status(): Promise<HookInstallState>
    install(): Promise<HookInstallState>
    uninstall(): Promise<HookInstallState>
  }
  /** Info about the app itself (e.g. whether the dev repo is available, repo path). */
  appInfo(): Promise<AppInfo>
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
  /** App-wide settings. */
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }
}

export interface AppSettings {
  /** Kill cockpit-owned tmux sessions when the app fully quits (default false — survival is the point). */
  killTmuxOnQuit: boolean
}

export interface AppInfo {
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
