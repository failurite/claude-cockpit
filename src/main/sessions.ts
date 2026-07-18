import { EventEmitter } from 'events'
import { existsSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
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
  getFlag,
  type PersistedSession,
  type ArchivedSession
} from './store.js'
import { watchTranscriptForSession, transcriptExists } from './transcripts.js'
import {
  isTmuxAvailable,
  devLaunchCommand,
  devSessionStartCommand,
  tmuxWrap,
  tmuxHasSession,
  tmuxSessionPaneId,
  killCockpitSession,
  listCockpitSessions,
  enableMouse,
  DEV_TMUX_NAME,
  TMUX_PREFIX
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
/** Claude Code `/model` aliases we accept from the UI (besides any `claude-*` id). */
const KNOWN_MODEL_ARGS = new Set([
  'default',
  'best',
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'opusplan',
  'opus[1m]',
  'sonnet[1m]'
])

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
      // Persist the tmux name so restore re-attaches the same live process.
      tmuxSession: p.session.tmuxSession,
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
        issue: s.issue ?? null,
        // Re-attach the same tmux session if it's still alive (process persists);
        // if it's gone, attach-or-create makes a fresh one and --resume restores
        // the conversation.
        tmuxSession: s.tmuxSession ?? null
      })
      // Reopen this pane's embedded-browser tabs (cookies/logins persist via the profile).
      if (s.browserTabs?.length) this.browser.restoreTabs?.(session.id, s.browserTabs)
    }
  }

  /**
   * Kill any cockpit-owned tmux session that no live pane owns — orphans left by
   * a crash or hard kill (clean teardown already kills tmux via close/archive).
   * Call once at boot, AFTER restore() + the dev session exist, so we never sweep
   * a session we're about to (or just did) re-attach.
   */
  sweepOrphanTmux(): void {
    if (!isTmuxAvailable()) return
    const owned = new Set<string>()
    for (const p of this.panes.values()) {
      if (p.session.tmuxSession) owned.add(p.session.tmuxSession)
    }
    for (const name of listCockpitSessions()) {
      if (!owned.has(name)) killCockpitSession(name)
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
    /** Persisted tmux session name to re-attach on restore (null = mint a fresh one). */
    tmuxSession?: string | null
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

    // Every claude session runs inside a persistent tmux session (when tmux is
    // available) so its process — and live state — survives an app restart; we
    // just re-attach. The tmux name IS the pane id, so it (and the frozen hook
    // env) stay stable across restarts. The dev session uses a fixed name; other
    // sessions carry a persisted name on restore or mint one when new. Persistence
    // for non-dev sessions is opt-out via the `disableSessionTmux` flag; dev always
    // persists.
    const useTmux =
      command === 'claude' &&
      isTmuxAvailable() &&
      (kind === 'dev' || !getFlag('disableSessionTmux'))
    const tmuxName = useTmux
      ? kind === 'dev'
        ? DEV_TMUX_NAME
        : opts?.tmuxSession || `${TMUX_PREFIX}${randomUUID().slice(0, 8)}`
      : null

    if (tmuxName) {
      const existing = this.panes.get(tmuxName)
      if (existing) return existing.session
      // Dev only: flag drift. `new-session -A` re-attach ignores flags, so a
      // long-lived dev session keeps whatever it was first created with (e.g. a
      // stale `--chrome` that opens EXTERNAL Chrome). If the live command differs
      // from what we'd launch now, kill it so attach-or-create recreates it fresh.
      // (Other sessions don't drift-check — their command legitimately changes as
      // they learn --resume; apply flag changes with ⟳ Restart or close+reopen.)
      if (kind === 'dev') {
        const desiredCmd = ['claude', ...claudeFlags(options)].join(' ').trim()
        const liveCmd = devSessionStartCommand()
        if (liveCmd && liveCmd !== desiredCmd) killCockpitSession(DEV_TMUX_NAME)
      }
    }

    // Re-attaching a live tmux session? Then claude is already running (past its
    // SessionStart hook), so no hook will move us off 'starting' until you
    // interact. Start such panes at 'idle' (ready) — the next hook corrects it if
    // it was actually mid-work. A fresh session stays 'starting' until SessionStart.
    let reattaching = !!tmuxName && tmuxHasSession(tmuxName)

    // Migration: a session created before the per-session `-e` env fix carries the
    // wrong pane id (the server/dev pane's), so its hooks misreport and it never
    // updates. Recreate it (conversation restored via --resume) so it gets correct
    // env. The dev session is exempt — it started the server, so its env is right.
    if (reattaching && tmuxName && kind !== 'dev' && tmuxSessionPaneId(tmuxName) !== tmuxName) {
      killCockpitSession(tmuxName)
      reattaching = false
    }

    // Bump seq once per pane so "Session N" fallback names stay unique even for
    // tmux-backed panes (whose id is the tmux name, not `pane-N`).
    const seqNum = ++seq
    const id = tmuxName ?? `pane-${seqNum}-${Date.now().toString(36)}`
    // New sessions get a generic, unique name; restores carry their persisted name
    // via opts.name. We deliberately don't inherit the last session's name for the
    // same cwd/command — a fresh "New session" should look fresh.
    const name = opts?.name || `Session ${seqNum}`

    // Only resume if the conversation's transcript still exists — otherwise
    // `claude --resume <id>` leaves a pane stuck on "No conversation found with
    // session ID" (the transcript was deleted, cloud-evicted, or from another
    // machine). Fall back to a fresh session instead.
    const resumeId =
      opts?.resumeId && transcriptExists(opts.resumeId) ? opts.resumeId : null

    const launch = this.buildLaunch({
      command,
      cwd,
      options,
      resumeId,
      initialPrompt: opts?.initialPrompt,
      kind,
      tmuxName
    })
    const proc = this.spawnPty(id, cwd, launch)

    const session: TerminalSession = {
      id,
      name,
      cwd,
      command,
      kind,
      workspaceId,
      options,
      tmuxSession: tmuxName,
      issue: opts?.issue ?? null,
      claudeSessionId: null,
      status: reattaching ? 'idle' : 'starting',
      subagentCount: 0,
      tokensTotal: 0,
      model: null,
      usingChrome: false,
      chromeActivity: null,
      lastActivity: reattaching ? 're-attached' : 'launching',
      updatedAt: Date.now()
    }
    const pane: Pane = { session, proc, buffer: '' }
    this.panes.set(id, pane)

    // Re-attached (or --resume) sessions won't fire a hook until you interact —
    // bind the transcript watch now (using the known conversation id) so the
    // model / token / sub-agent readouts populate immediately instead of after
    // the first prompt.
    if (resumeId) this.bindClaudeSession(id, resumeId)

    // Scrolling fix: tmux without mouse mode turns trackpad wheel into arrow keys
    // for alt-screen apps. Set it once the session exists (retry covers first create).
    if (tmuxName) {
      setTimeout(() => enableMouse(tmuxName), 1000)
      setTimeout(() => enableMouse(tmuxName), 4000)
    }

    this.wireProc(pane, id)

    this.emitSessions()
    this.persist()
    return session
  }

  /**
   * Build the `claude` launch command line for a pane. Extracted so create() and
   * restart() stay in lockstep (same flags, same resume/kickoff ordering).
   */
  private buildLaunch(o: {
    command: string
    cwd: string
    options: SessionOptions
    resumeId: string | null
    initialPrompt?: string
    kind: 'normal' | 'dev'
    tmuxName: string | null
  }): string {
    if (o.kind === 'dev' && o.tmuxName) {
      // The dev session stays plain `claude <flags>` (no browser/cross-session MCP,
      // no --resume — it relies on tmux persistence). Its drift check compares the
      // inner command; the `-e` env args are tmux flags and don't affect it.
      return devLaunchCommand(o.cwd, claudeFlags(o.options), this.paneEnv(o.tmuxName))
    }
    if (o.command !== 'claude') return o.command
    // Build `claude [prompt] <flags> [--resume <id>]`.
    const parts = [
      'claude',
      // Kickoff prompt (e.g. issue context) — only on first launch, not on resume.
      // It MUST precede the flags: `--mcp-config <configs...>` is variadic and
      // would swallow a trailing positional as a config path.
      ...(o.initialPrompt && !o.resumeId ? [quoteArg(o.initialPrompt)] : []),
      ...claudeFlags(o.options, this.browser.mcpConfig, this.sessions.mcpConfig),
      ...(o.resumeId ? ['--resume', o.resumeId] : [])
    ]
    const inner = parts.join(' ')
    // A tmux-backed session wraps the command so it survives app restarts (the
    // inner command runs on first create; re-attach ignores it). The `-e` env
    // (via paneEnv) makes each session's hooks report to its OWN pane. No tmux →
    // run the command directly and rely on `--resume` across restarts.
    return o.tmuxName ? tmuxWrap(o.tmuxName, o.cwd, inner, this.paneEnv(o.tmuxName)) : inner
  }

  /**
   * Spawn a shell that runs the launch command so the pane *is* claude with no
   * lingering prompt. The shell + args differ per OS (login zsh `exec` on POSIX,
   * `cmd.exe /c` on Windows) — see platform.ts. The pane-scoped env lets the hook
   * + MCP shims phone home to the right pane.
   */
  /**
   * The pane-scoped env the hook + MCP shims read to phone home to the right pane.
   * Used both for the pty's env AND (crucially) as tmux `-e` args — a tmux session
   * on an existing server otherwise inherits the server's (dev pane's) env.
   */
  private paneEnv(id: string): Record<string, string> {
    return {
      CLAUDE_COCKPIT: '1',
      CLAUDE_COCKPIT_PANE_ID: id,
      CLAUDE_COCKPIT_INGEST_PORT: String(this.ingestPort),
      // The cockpit-browser MCP shim (spawned by claude) reaches the app's browser
      // RPC endpoint via this, scoped to this pane.
      CLAUDE_COCKPIT_BROWSER_PORT: String(this.browser.port),
      // The cockpit-sessions MCP shim reaches the cross-session RPC endpoint
      // (list/read sibling sessions) via this, scoped to this pane.
      CLAUDE_COCKPIT_SESSIONS_PORT: String(this.sessions.port)
    }
  }

  private spawnPty(id: string, cwd: string, launch: string): IPty {
    const { shell, args } = buildShellInvocation(launch)
    return pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, ...this.paneEnv(id) } as Record<string, string>
    })
  }

  /** Wire a pane's pty output → buffer + 'data' event, and exit → status. */
  private wireProc(pane: Pane, id: string): void {
    pane.proc.onData((chunk) => {
      pane.buffer += chunk
      if (pane.buffer.length > MAX_BUFFER) pane.buffer = pane.buffer.slice(-MAX_BUFFER)
      this.emit('data', id, chunk)
    })
    pane.proc.onExit(() => {
      this.patch(id, { status: 'exited', lastActivity: 'process exited' })
      pane.unwatch?.()
    })
  }

  /**
   * Relaunch a session's `claude` process in place — same pane, same position,
   * resuming its conversation (via `--resume`) so state is retained as much as
   * possible. Useful to pick up a newly-available model or apply changed launch
   * options without losing the conversation. The dev (tmux) session is exempt —
   * restarting it would kill the very session driving Cockpit.
   */
  restart(id: string, optionOverrides?: Partial<SessionOptions>): TerminalSession | null {
    const p = this.panes.get(id)
    if (!p || p.session.kind === 'dev' || p.session.command !== 'claude') return null
    const s = p.session
    const options = optionOverrides ? { ...s.options, ...optionOverrides } : s.options
    // Resume the same conversation if its transcript still exists; otherwise start
    // fresh and forget the stale id so the hook can bind the new conversation.
    const resumeId = s.claudeSessionId && transcriptExists(s.claudeSessionId) ? s.claudeSessionId : null

    // Tear down the old process + transcript watch.
    p.unwatch?.()
    p.unwatch = undefined
    try {
      p.proc.kill()
    } catch {
      /* already dead */
    }
    // For a tmux-backed session, killing the pty only detaches — the claude
    // process keeps running and attach-or-create would just re-attach it. Kill
    // the tmux session so the relaunch starts a genuinely fresh claude.
    if (s.tmuxSession) killCockpitSession(s.tmuxSession)
    if (!resumeId && s.claudeSessionId) {
      this.claudeIndex.delete(s.claudeSessionId)
      s.claudeSessionId = null
    }

    const cwd = resolveSpawnDir(s.cwd)
    const launch = this.buildLaunch({
      command: s.command,
      cwd,
      options,
      resumeId,
      kind: s.kind,
      tmuxName: s.tmuxSession
    })
    p.buffer = ''
    p.proc = this.spawnPty(id, cwd, launch)
    this.wireProc(p, id)

    // Re-attach the transcript watch for a resumed conversation (its
    // claudeSessionId is unchanged, so bindClaudeSession would no-op).
    if (resumeId) {
      p.unwatch = watchTranscriptForSession(resumeId, (stats) =>
        this.patch(id, {
          subagentCount: stats.subagents,
          tokensTotal: stats.tokens,
          model: stats.model ?? undefined
        })
      )
    }

    Object.assign(s, {
      options,
      status: 'starting' as SessionStatus,
      subagentCount: 0,
      tokensTotal: 0,
      model: null,
      usingChrome: false,
      chromeActivity: null,
      lastActivity: 'restarting',
      updatedAt: Date.now()
    })
    this.emit('reset', id) // tell the renderer to clear the now-stale terminal view
    this.emitSessions()
    this.persist()
    return s
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
    // Killing the pty only detaches from tmux — kill the tmux session too so the
    // claude process doesn't linger past the pane (no orphaned sessions).
    if (p.session.tmuxSession) killCockpitSession(p.session.tmuxSession)
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

  /** Close every live pane belonging to a workspace (used when it's removed). */
  closeForWorkspace(workspaceId: string): void {
    for (const [id, p] of [...this.panes.entries()]) {
      if (p.session.workspaceId === workspaceId) this.close(id)
    }
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
    // Archive means "close & save": kill the tmux process too (reopen later via
    // --resume). A fresh tmux session is minted on restoreArchived().
    if (p.session.tmuxSession) killCockpitSession(p.session.tmuxSession)
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
    p.unwatch = watchTranscriptForSession(claudeSessionId, (stats) =>
      this.patch(paneId, {
        subagentCount: stats.subagents,
        tokensTotal: stats.tokens,
        model: stats.model ?? undefined
      })
    )
    this.patch(paneId, {})
    this.persist()
  }

  /**
   * Switch a session's model by typing `/model <arg>` into its pty (reuses the
   * paste-then-delayed-Enter submit). `arg` is a Claude Code model alias
   * (`opus`/`sonnet`/`haiku`/`default`/…) or a `claude-*` id; anything else is
   * rejected so we never inject arbitrary text. The transcript watcher reflects
   * the new model back into `session.model` once the next turn lands.
   */
  setModel(paneId: string, arg: string): void {
    const a = (arg || '').trim()
    const ok = /^claude-[\w.[\]-]+$/i.test(a) || KNOWN_MODEL_ARGS.has(a)
    if (!ok) return
    this.sendPrompt(paneId, `/model ${a}`)
  }

  /** Cumulative tokens across all live sessions' conversations (for the load meter). */
  totalTokens(): number {
    let sum = 0
    for (const p of this.panes.values()) sum += p.session.tokensTotal || 0
    return sum
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
