import { EventEmitter } from 'events'
import { homedir } from 'os'
import { join } from 'path'
import pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import type { SessionOptions, SessionStatus, TerminalSession } from '../shared/types.js'
import { DEFAULT_SESSION_OPTIONS } from '../shared/types.js'
import {
  getSavedName,
  saveName,
  saveSessions,
  getSavedSessions,
  type PersistedSession
} from './store.js'
import { watchTranscriptForSession } from './transcripts.js'
import { isTmuxAvailable, devLaunchCommand, enableMouse, sq, DEV_TMUX_NAME } from './tmux.js'
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
 * Map session options to `claude` CLI flags (order is stable for readability).
 * When `browserMcpConfig` is given, the "chrome" option wires Cockpit's embedded
 * browser (a per-session MCP server) instead of `--chrome` (external Chrome).
 */
function claudeFlags(options: SessionOptions, browserMcpConfig?: string | null): string[] {
  const flags: string[] = []
  if (options.dangerouslySkipPermissions) flags.push('--dangerously-skip-permissions')
  if (options.chrome) {
    // Embedded by default; only use external Chrome when explicitly opted in (or
    // if no embedded config is available as a fallback). JSON.stringify quotes the
    // path so spaces (e.g. "Application Support") survive the shell `exec`.
    if (!options.externalChrome && browserMcpConfig) flags.push('--mcp-config', JSON.stringify(browserMcpConfig))
    else flags.push('--chrome')
  }
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
    } = { mcpConfig: null, port: 0 }
  ) {
    super()
  }

  list(): TerminalSession[] {
    return [...this.panes.values()].map((p) => p.session)
  }

  private emitSessions(): void {
    this.emit('sessions', this.list())
  }

  /** Write the current pane set to disk so it can be restored next launch. */
  private persist(): void {
    const sessions: PersistedSession[] = [...this.panes.values()].map((p) => ({
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
    }))
    saveSessions(sessions)
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
    const cwd = expandTilde(opts?.cwd || homedir())
    const command = opts?.command || 'claude'
    const kind = opts?.kind || 'normal'
    const options: SessionOptions = { ...DEFAULT_SESSION_OPTIONS, ...opts?.options }
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
    }
    const id = tmuxDev ? DEV_TMUX_NAME : `pane-${++seq}-${Date.now().toString(36)}`
    const nameKey = `${cwd}::${command}`
    const name = opts?.name || getSavedName(nameKey) || `Session ${seq}`

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
              ...claudeFlags(options, this.browser.mcpConfig),
              ...(opts?.resumeId ? ['--resume', opts.resumeId] : []),
              // Kickoff prompt (e.g. issue context) — only on first launch, not resume.
              ...(opts?.initialPrompt && !opts?.resumeId ? [sq(opts.initialPrompt)] : [])
            ]
          : [command]
      launch = parts.join(' ')
    }

    const shell = process.env.SHELL || '/bin/zsh'
    // Login shell so GUI-launched apps still get the user's PATH, then exec the
    // target so the pane *is* claude (no lingering shell prompt).
    const args = ['-l', '-c', `exec ${launch}`]

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
        CLAUDE_COCKPIT_BROWSER_PORT: String(this.browser.port)
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
    saveName(`${p.session.cwd}::${p.session.command}`, name)
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
