import { EventEmitter } from 'events'
import { homedir } from 'os'
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
import { isTmuxAvailable, devLaunchCommand, DEV_TMUX_NAME } from './tmux.js'

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

/** Map session options to `claude` CLI flags (order is stable for readability). */
function claudeFlags(options: SessionOptions): string[] {
  const flags: string[] = []
  if (options.dangerouslySkipPermissions) flags.push('--dangerously-skip-permissions')
  if (options.chrome) flags.push('--chrome')
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

  constructor(private ingestPort: number) {
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
      options: p.session.options
    }))
    saveSessions(sessions)
  }

  /** Recreate panes saved from a previous run (called once at startup). */
  restore(): void {
    for (const s of getSavedSessions()) {
      this.create({
        cwd: s.cwd,
        command: s.command,
        name: s.name,
        kind: s.kind,
        workspaceId: s.workspaceId,
        options: s.options,
        resumeId: s.claudeSessionId
      })
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
  }): TerminalSession {
    const cwd = opts?.cwd || homedir()
    const command = opts?.command || 'claude'
    const kind = opts?.kind || 'normal'
    const options: SessionOptions = { ...DEFAULT_SESSION_OPTIONS, ...opts?.options }
    const workspaceId = opts?.workspaceId ?? null

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
      launch = devLaunchCommand(cwd)
    } else {
      // Build `claude <flags> [--resume <id>]`. Non-claude commands launch verbatim.
      const parts =
        command === 'claude'
          ? ['claude', ...claudeFlags(options), ...(opts?.resumeId ? ['--resume', opts.resumeId] : [])]
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
        CLAUDE_COCKPIT_INGEST_PORT: String(this.ingestPort)
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
    this.emitSessions()
    this.persist()
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
