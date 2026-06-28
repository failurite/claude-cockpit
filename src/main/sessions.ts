import { EventEmitter } from 'events'
import { existsSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import type {
  ArchivedSessionInfo,
  SessionOptions,
  SessionStatus,
  TerminalSession
} from '../shared/types.js'
import { DEFAULT_SESSION_OPTIONS } from '../shared/types.js'
import {
  saveSessions,
  getSavedSessions,
  getArchivedSessions,
  saveArchivedSessions,
  type PersistedSession,
  type ArchivedSession
} from './store.js'
import { watchTranscriptForSession } from './transcripts.js'
import {
  isTmuxAvailable,
  devLaunchCommand,
  devSessionStartCommand,
  killCockpitSession,
  enableMouse,
  DEV_TMUX_NAME
} from './tmux.js'
import { buildShellInvocation, quoteArg, quotePath } from './platform.js'
import type { IssueRef } from '../shared/types.js'
import { COCKPIT_WORKSPACE_ID } from '../shared/types.js'

/** Cap on retained pty output for replay when a terminal view (re)mounts. */
const MAX_BUFFER = 200_000

interface Pane {
  session: TerminalSession
  proc: IPty
  /** Recent pty output, replayed to the renderer on attach. */
  buffer: string
  /** dispose the transcript watcher, if any */
  unwatch?: () => void
}

let seq = 0

/** Canonical options for the Cockpit Dev session: plain `claude`, no browser. */
const DEV_SESSION_OPTIONS: SessionOptions = {
  // The dev session works on Cockpit itself in a trusted local repo — skip the
  // permission prompts so it can iterate freely.
  dangerouslySkipPermissions: true,
  chrome: false,
  externalChrome: false,
  extraArgs: ''
}

/**
 * Expand a leading `~` to the user's home dir. The OS never expands tilde, so a
 * cwd like `~/code/house` (e.g. a workspace path typed by hand) would make
 * `pty.spawn` fail to start and the pane would exit instantly. Resolve it here,
 * the single choke point every session passes through.
 */
export function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/**
 * Resolve a directory a pty can actually spawn in. node-pty exits the process
 * immediately if `cwd` doesn't exist — which is exactly what a folder-less
 * workspace (blank path) or a "set up later" path that isn't created yet would
 * hit. So: blank → home dir; a path that doesn't exist → create it (the "new
 * work" intent); if creating fails (typo, permissions) → fall back to home dir
 * so the session always launches instead of silently exiting.
 */
function resolveSpawnDir(raw: string | undefined): string {
  const home = homedir()
  const dir = expandTilde((raw ?? '').trim())
  if (!dir) return home
  try {
    if (existsSync(dir)) return statSync(dir).isDirectory() ? dir : home
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return home
  }
}

/**
 * Map session options to `claude` CLI flags (order is stable for readability).
 * When `browserMcpConfig` is given, the "chrome" option wires Cockpit's embedded
 * browser (a per-session MCP server) instead of `--chrome` (external Chrome).
 * `sessionsMcpConfig`, when given, registers the cross-session MCP server so this
 * session can see/read its siblings — always on for normal sessions.
 */
function claudeFlags(
  options: SessionOptions,
  browserMcpConfig?: string | null,
  sessionsMcpConfig?: string | null
): string[] {
  const flags: string[] = []
  if (options.dangerouslySkipPermissions) flags.push('--dangerously-skip-permissions')
  // External Chrome is the ONLY path that uses Claude's native Claude-in-Chrome
  // connector; opt in explicitly, or fall back to it if no embedded config exists.
  const useExternalChrome = options.chrome && (options.externalChrome || !browserMcpConfig)
  if (useExternalChrome) {
    flags.push('--chrome')
  } else {
    // Embedded browsing (or no browser at all): force `--no-chrome` so a globally
    // enabled connector (claudeInChromeDefaultEnabled) can't pop open a real
    // Chrome window. Sessions browse only via Cockpit's embedded WebContentsView,
    // wired through the cockpit-browser MCP. quoteArg quotes the path so spaces
    // (e.g. "Application Support") survive the shell — and, on Windows, without
    // the backslash-doubling that JSON.stringify would inflict on a `C:\…` path.
    flags.push('--no-chrome')
    if (options.chrome && browserMcpConfig) flags.push('--mcp-config', quotePath(browserMcpConfig))
  }
  // Cross-session visibility is independent of browsing — a separate --mcp-config
  // occurrence (Claude merges repeated flags), quoted so spaces in the path survive.
  if (sessionsMcpConfig) flags.push('--mcp-config', quotePath(sessionsMcpConfig))
  const extra = options.extraArgs.trim()
  if (extra) flags.push(extra)
  return flags
}

/**
 * Owns every pty + the derived TerminalSession state. Emits:
 *   'data'     (paneId, chunk)        pty output
 *   'sessions' (TerminalSession[])    any state change
 */
export class SessionManager extends EventEmitter {
  private panes = new Map<string, Pane>()
  /** claudeSessionId -> paneId, so hooks/transcripts that only know Claude's id can map back. */
  private claudeIndex = new Map<string, string>()

  /**
   * @param ingestPort port the status hooks POST to.
   * @param browser embedded-browser wiring for normal sessions: the generated
   *   `--mcp-config` path and the RPC port the MCP shim reaches (env-injected).
   */
  constructor(
    private ingestPort: number,
    private browser: {
      mcpConfig: string | null
      port: number
      /** Snapshot a pane's embedded-browser tabs for persistence. */
      getTabs?: (paneId: string) => { url: string; active: boolean }[]
      /** Reopen a restored pane's embedded-browser tabs. */
      restoreTabs?: (paneId: string, tabs: { url: string; active: boolean }[]) => void
    } = { mcpConfig: null, port: 0 },
    /** Cross-session MCP wiring: the shared --mcp-config path + the RPC port the
     *  cockpit-sessions shim reaches (env-injected, like the browser one). */
    private sessions: { mcpConfig: string | null; port: number } = { mcpConfig: null, port: 0 }
  ) {
    super()
  }

  list(): TerminalSession[] {
    return [...this.panes.values()].map((p) => p.session)
  }

  private emitSessions(): void {
    this.emit('sessions', this.list())
  }

  /** Snapshot one pane as a persistable record (current options, issue, browser tabs). */
  private toPersisted(p: Pane): PersistedSession {
    return {
      name: p.session.name,
      cwd: p.session.cwd,
      command: p.session.command,
      kind: p.session.kind,
      claudeSessionId: p.session.claudeSessionId,
      workspaceId: p.session.workspaceId,
      options: p.session.options,
      issue: p.session.issue,
      // Drop blank tabs so we don't restore empty about:blank panes.
      browserTabs: (this.browser.getTabs?.(p.session.id) ?? []).filter(
        (t) => t.url && t.url !== 'about:blank'
      )
    }
  }

  /** Write the current pane set to disk so it can be restored next launch. */
  private persist(): void {
    saveSessions([...this.panes.values()].map((p) => this.toPersisted(p)))
  }

  /** Re-persist now (e.g. when embedded-browser tabs change, which we don't otherwise observe). */
  persistNow(): void {
    this.persist()
  }

  /** Recreate panes saved from a previous run (called once at startup). */
  restore(): void {
    for (const s of getSavedSessions()) {
      const session = this.create({
        cwd: s.cwd,
        command: s.command,
        name: s.name,
        kind: s.kind,
        workspaceId: s.workspaceId,
        options: s.options,
        resumeId: s.claudeSessionId,
        issue: s.issue ?? null
      })
      // Reopen this pane's embedded-browser tabs (cookies/logins persist via the profile).
      if (s.browserTabs?.length) this.browser.restoreTabs?.(session.id, s.browserTabs)
    }
  }

  create(opts?: {
    cwd?: string
    command?: string
    name?: string
    kind?: 'normal' | 'dev'
    workspaceId?: string | null
    options?: Partial<SessionOptions>
    /** If set (and command is claude), launch `claude … --resume <id>` to restore a conversation. */
    resumeId?: string | null
    /** The GitHub issue this session is dedicated to (cwd should be its worktree). */
    issue?: IssueRef | null
    /** Kickoff prompt passed to claude on first launch (not on resume). */
    initialPrompt?: string
  }): TerminalSession {
    const cwd = resolveSpawnDir(opts?.cwd)
    const command = opts?.command || 'claude'
    const kind = opts?.kind || 'normal'
    // The dev session is special: ALWAYS plain `claude` (no browser), regardless
    // of stale persisted options — otherwise a dev session first created with
    // chrome:true would keep opening external Chrome forever.
    const options: SessionOptions =
      kind === 'dev' ? { ...DEV_SESSION_OPTIONS } : { ...DEFAULT_SESSION_OPTIONS, ...opts?.options }
    // Dev sessions always live in the built-in Cockpit workspace (also migrates
    // panes persisted before that workspace existed).
    const workspaceId = kind === 'dev' ? COCKPIT_WORKSPACE_ID : (opts?.workspaceId ?? null)

    // The dev session is special: when tmux is available it runs inside a
    // persistent tmux server (survives app restarts) under a stable pane id, so
    // its frozen hook env keeps matching after we re-attach.
    const tmuxDev = kind === 'dev' && isTmuxAvailable()
    if (tmuxDev) {
      const existing = this.panes.get(DEV_TMUX_NAME)
      if (existing) return existing.session
      // Flag drift: `new-session -A` re-attach ignores flags, so a long-lived dev
      // session keeps whatever it was first created with (e.g. a stale `--chrome`
      // that opens EXTERNAL Chrome instead of the embedded browser). If the live
      // session's command differs from what we'd launch now, kill it so the
      // attach-or-create below recreates it fresh with the current flags.
      const desiredCmd = ['claude', ...claudeFlags(options)].join(' ').trim()
      const liveCmd = devSessionStartCommand()
      if (liveCmd && liveCmd !== desiredCmd) killCockpitSession(DEV_TMUX_NAME)
    }
    const id = tmuxDev ? DEV_TMUX_NAME : `pane-${++seq}-${Date.now().toString(36)}`
    // New sessions get a generic, unique name; restores carry their persisted name
    // via opts.name. We deliberately don't inherit the last session's name for the
    // same cwd/command — a fresh "New session" should look fresh.
    const name = opts?.name || `Session ${seq}`

    let launch: string
    if (tmuxDev) {
      // attach-or-create the persistent dev session; tmux keeps claude alive.
      // Flags (e.g. --dangerously-skip-permissions --chrome) apply on first create.
      launch = devLaunchCommand(cwd, claudeFlags(options))
    } else {
      // Build `claude <flags> [--resume <id>]`. Non-claude commands launch verbatim.
      const parts =
        command === 'claude'
          ? [
              'claude',
              // Kickoff prompt (e.g. issue context) — only on first launch, not on
              // resume. It MUST precede the flags: `--mcp-config <configs...>` is
              // variadic and would swallow a trailing positional as a config path.
              ...(opts?.initialPrompt && !opts?.resumeId ? [quoteArg(opts.initialPrompt)] : []),
              ...claudeFlags(options, this.browser.mcpConfig, this.sessions.mcpConfig),
              ...(opts?.resumeId ? ['--resume', opts.resumeId] : [])
            ]
          : [command]
      launch = parts.join(' ')
    }

    // Spawn a shell that runs the launch command so the pane *is* claude with no
    // lingering prompt. The shell + args differ per OS (login zsh `exec` on POSIX,
    // `cmd.exe /c` on Windows) — see platform.ts.
    const { shell, args } = buildShellInvocation(launch)

    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        CLAUDE_COCKPIT: '1',
        CLAUDE_COCKPIT_PANE_ID: id,
        CLAUDE_COCKPIT_INGEST_PORT: String(this.ingestPort),
        // The cockpit-browser MCP shim (spawned by claude) inherits this to reach
        // the app's browser RPC endpoint, scoped to this pane.
        CLAUDE_COCKPIT_BROWSER_PORT: String(this.browser.port),
        // The cockpit-sessions MCP shim inherits this to reach the app's
        // cross-session RPC endpoint (list/read sibling sessions), scoped to this pane.
        CLAUDE_COCKPIT_SESSIONS_PORT: String(this.sessions.port)
      } as Record<string, string>
    })

    const session: TerminalSession = {
      id,
      name,
      cwd,
      command,
      kind,
      workspaceId,
      options,
      tmuxSession: tmuxDev ? DEV_TMUX_NAME : null,
      issue: opts?.issue ?? null,
      claudeSessionId: null,
      status: 'starting',
      subagentCount: 0,
      usingChrome: false,
      chromeActivity: null,
      lastActivity: 'launching',
      updatedAt: Date.now()
    }
    const pane: Pane = { session, proc, buffer: '' }
    this.panes.set(id, pane)

    // Scrolling fix: tmux without mouse mode turns trackpad wheel into arrow keys
    // for alt-screen apps. Set it once the session exists (retry covers first create).
    if (tmuxDev) {
      setTimeout(() => enableMouse(DEV_TMUX_NAME), 1000)
      setTimeout(() => enableMouse(DEV_TMUX_NAME), 4000)
    }

    proc.onData((chunk) => {
      pane.buffer += chunk
      if (pane.buffer.length > MAX_BUFFER) pane.buffer = pane.buffer.slice(-MAX_BUFFER)
      this.emit('data', id, chunk)
    })
    proc.onExit(() => {
      this.patch(id, { status: 'exited', lastActivity: 'process exited' })
      pane.unwatch?.()
    })

    this.emitSessions()
    this.persist()
    return session
  }

  /** Output captured so far (for replay when a terminal view mounts). */
  getBuffer(id: string): string {
    return this.panes.get(id)?.buffer ?? ''
  }

  write(id: string, data: string): void {
    this.panes.get(id)?.proc.write(data)
  }

  /**
   * Type a prompt into a session and submit it. The Enter is sent as a SEPARATE,
   * delayed keystroke on purpose: Claude's TUI treats a fast burst of characters
   * as a *paste*, so a `\r` bundled onto the end becomes a literal newline in the
   * input (it sits there unsent) instead of submitting. A standalone Enter that
   * arrives after the paste settles registers as a real submit. Used for the
   * Done-flow instructions Cockpit hands to a session (dirty / merge conflict).
   */
  sendPrompt(id: string, text: string): void {
    const p = this.panes.get(id)
    if (!p) return
    p.proc.write(text)
    setTimeout(() => this.panes.get(id)?.proc.write('\r'), 150)
  }

  resize(id: string, cols: number, rows: number): void {
    const p = this.panes.get(id)
    if (!p) return
    try {
      p.proc.resize(Math.max(cols, 1), Math.max(rows, 1))
    } catch {
      /* pty may have exited */
    }
  }

  rename(id: string, name: string): void {
    const p = this.panes.get(id)
    if (!p) return
    p.session.name = name
    this.patch(id, {})
    this.persist()
  }

  close(id: string): void {
    const p = this.panes.get(id)
    if (!p) return
    p.unwatch?.()
    try {
      p.proc.kill()
    } catch {
      /* already dead */
    }
    if (p.session.claudeSessionId) this.claudeIndex.delete(p.session.claudeSessionId)
    this.panes.delete(id)
    this.emit('closed', id) // let the BrowserManager tear down this pane's tabs
    this.emitSessions()
    this.persist()
  }

  /** Close every pane (kills ptys, clears persisted state). tmux is killed by the caller. */
  closeAll(): void {
    for (const id of [...this.panes.keys()]) this.close(id)
  }

  /**
   * Archive a pane: capture its full launch record (conversation id + current
   * browser tabs) into the archived store, then tear the live pane down like
   * close(). The conversation itself lives in ~/.claude, so a later
   * restoreArchived() brings it back via `claude --resume` with its tabs reopened.
   * The dev session can't be archived (it auto-opens every launch).
   */
  archive(id: string): void {
    const p = this.panes.get(id)
    if (!p || p.session.kind === 'dev') return
    // Capture tabs BEFORE the 'closed' teardown disposes the WebContentsViews.
    const record: ArchivedSession = {
      ...this.toPersisted(p),
      archivedId: `arch-${Date.now().toString(36)}-${++seq}`,
      archivedAt: Date.now()
    }
    saveArchivedSessions([...getArchivedSessions(), record])
    // Same teardown as close() (but the persisted record lives on in `archived`).
    p.unwatch?.()
    try {
      p.proc.kill()
    } catch {
      /* already dead */
    }
    if (p.session.claudeSessionId) this.claudeIndex.delete(p.session.claudeSessionId)
    this.panes.delete(id)
    this.emit('closed', id)
    this.emitSessions()
    this.persist()
  }

  /** Renderer-facing summary of every archived session. */
  listArchivedInfo(): ArchivedSessionInfo[] {
    return getArchivedSessions().map((a) => ({
      archivedId: a.archivedId,
      name: a.name,
      workspaceId: a.workspaceId,
      kind: a.kind,
      issueNumber: a.issue?.number ?? null,
      hasConversation: !!a.claudeSessionId,
      tabCount: a.browserTabs?.length ?? 0,
      archivedAt: a.archivedAt
    }))
  }

  /** Reopen an archived session (drops it from the archive). Returns the new pane, or null. */
  restoreArchived(archivedId: string): TerminalSession | null {
    const all = getArchivedSessions()
    const rec = all.find((a) => a.archivedId === archivedId)
    if (!rec) return null
    saveArchivedSessions(all.filter((a) => a.archivedId !== archivedId))
    const session = this.create({
      cwd: rec.cwd,
      command: rec.command,
      name: rec.name,
      kind: rec.kind,
      workspaceId: rec.workspaceId,
      options: rec.options,
      resumeId: rec.claudeSessionId,
      issue: rec.issue ?? null
    })
    if (rec.browserTabs?.length) this.browser.restoreTabs?.(session.id, rec.browserTabs)
    return session
  }

  /** Permanently forget an archived session. */
  deleteArchived(archivedId: string): void {
    saveArchivedSessions(getArchivedSessions().filter((a) => a.archivedId !== archivedId))
  }

  /** Apply a partial update to a pane's session and broadcast. */
  private patch(id: string, partial: Partial<TerminalSession>): void {
    const p = this.panes.get(id)
    if (!p) return
    Object.assign(p.session, partial, { updatedAt: Date.now() })
    this.emitSessions()
  }

  /** Learn Claude's own sessionId for a pane (from a hook), and start watching its transcript. */
  bindClaudeSession(paneId: string, claudeSessionId: string): void {
    const p = this.panes.get(paneId)
    if (!p || p.session.claudeSessionId === claudeSessionId) return
    p.session.claudeSessionId = claudeSessionId
    this.claudeIndex.set(claudeSessionId, paneId)
    p.unwatch?.()
    p.unwatch = watchTranscriptForSession(claudeSessionId, (count) =>
      this.patch(paneId, { subagentCount: count })
    )
    this.patch(paneId, {})
    this.persist()
  }

  setStatus(paneId: string, status: SessionStatus, activity: string): void {
    this.patch(paneId, { status, lastActivity: activity })
  }

  /** Mark whether this session is currently driving Chrome, with an optional target. */
  setUsingChrome(paneId: string, using: boolean, activity: string | null = null): void {
    this.patch(paneId, { usingChrome: using, chromeActivity: using ? activity : null })
  }

  paneIdForClaudeSession(claudeSessionId: string): string | undefined {
    return this.claudeIndex.get(claudeSessionId)
  }

  /** Tear down all ptys on quit WITHOUT touching persisted state (so restore works). */
  disposeAll(): void {
    for (const p of this.panes.values()) {
      p.unwatch?.()
      try {
        p.proc.kill()
      } catch {
        /* already dead */
      }
    }
    this.panes.clear()
    this.claudeIndex.clear()
  }
}
