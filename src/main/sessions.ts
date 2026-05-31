import { EventEmitter } from 'events'
import { homedir } from 'os'
import pty from '@homebridge/node-pty-prebuilt-multiarch'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import type { SessionStatus, TerminalSession } from '../shared/types.js'
import { getSavedName, saveName } from './store.js'
import { watchTranscriptForSession } from './transcripts.js'

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

  create(opts?: { cwd?: string; command?: string; name?: string }): TerminalSession {
    const id = `pane-${++seq}-${Date.now().toString(36)}`
    const cwd = opts?.cwd || homedir()
    const command = opts?.command || 'claude'
    const nameKey = `${cwd}::${command}`
    const name = opts?.name || getSavedName(nameKey) || `Session ${seq}`

    const shell = process.env.SHELL || '/bin/zsh'
    // Login shell so GUI-launched apps still get the user's PATH, then exec the
    // target so the pane *is* claude (no lingering shell prompt).
    const args = ['-l', '-c', `exec ${command}`]

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
      claudeSessionId: null,
      status: 'starting',
      subagentCount: 0,
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
  }

  setStatus(paneId: string, status: SessionStatus, activity: string): void {
    this.patch(paneId, { status, lastActivity: activity })
  }

  paneIdForClaudeSession(claudeSessionId: string): string | undefined {
    return this.claudeIndex.get(claudeSessionId)
  }

  disposeAll(): void {
    for (const id of [...this.panes.keys()]) this.close(id)
  }
}
