// Shared type contract between the Electron main process and the renderer.

/** High-level state of a Claude session, derived from hooks + transcript. */
export type SessionStatus =
  | 'starting' // pty spawned, no signal yet
  | 'idle' // finished a turn, nothing pending (Stop / idle_prompt)
  | 'working' // actively running tools (PreToolUse seen, no Stop yet)
  | 'waiting' // needs the user: permission prompt or a question
  | 'exited' // the pty process ended

/** One terminal pane = one Claude (or shell) process owned by the app. */
export interface TerminalSession {
  /** Stable app-side id for the pane (assigned at spawn, survives Claude session restarts). */
  id: string
  /** User-assigned label (rename target). Defaults to e.g. "Session 1". */
  name: string
  /** Working directory the pty was spawned in. */
  cwd: string
  /** The command line spawned (e.g. "claude"). */
  command: string
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
  createSession(opts?: { cwd?: string; command?: string; name?: string }): Promise<TerminalSession>
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
}

export interface HookInstallState {
  installed: boolean
  command: string | null
}
