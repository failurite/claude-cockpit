import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type { IssueRef, SessionOptions, Workspace } from '../shared/types.js'

/** A pane as persisted to disk so it can be restored on next launch. */
export interface PersistedSession {
  name: string
  cwd: string
  command: string
  kind: 'normal' | 'dev'
  /** Claude's session id, so we can `claude --resume <id>` to restore the conversation. */
  claudeSessionId: string | null
  /** Workspace this session belonged to (null for the dev session / ad-hoc). */
  workspaceId: string | null
  /** Launch options, so the claude command is rebuilt identically on restore. */
  options: SessionOptions
  /** tmux session name backing this pane, so restore re-attaches the live process (null / absent = none). */
  tmuxSession?: string | null
  /** Embedded-browser tabs (URLs) to reopen on restore; logins persist via the profile. */
  browserTabs?: { url: string; active: boolean }[]
  /** The GitHub issue this session is dedicated to (restores the mapping + worktree cwd). */
  issue?: IssueRef | null
}

/** A persisted session that's been archived (closed but saved to reopen on demand). */
export interface ArchivedSession extends PersistedSession {
  /** Stable id for reopen / delete. */
  archivedId: string
  /** ms epoch when it was archived. */
  archivedAt: number
}

/**
 * Tiny JSON-file store for things that should survive restarts:
 *   - the set of open panes (including their names), for restore-on-launch
 *   - workspaces (directory + default launch options)
 */
interface Persisted {
  sessions: PersistedSession[]
  /** Closed-but-saved sessions, reopenable on demand (not auto-restored on boot). */
  archived: ArchivedSession[]
  workspaces: Workspace[]
  /** One-time flags, e.g. whether we've already auto-installed status hooks. */
  flags: Record<string, boolean>
  /** Durable renderer UI state that must survive restarts (localStorage is
   *  origin-scoped and unreliable across dev/packaged builds). A generic bag:
   *  `collapsedWorkspaces`, `activeSessionId`, per-workspace issue panel state, etc. */
  uiState: Record<string, unknown>
}

function empty(): Persisted {
  return { sessions: [], archived: [], workspaces: [], flags: {}, uiState: {} }
}

let cache: Persisted = empty()
let filePath = ''

export function initStore(): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  filePath = join(dir, 'claude-cockpit.json')
  if (existsSync(filePath)) {
    try {
      cache = { ...empty(), ...JSON.parse(readFileSync(filePath, 'utf8')) }
    } catch {
      cache = empty()
    }
  }
}

function flush(): void {
  if (!filePath) return
  try {
    writeFileSync(filePath, JSON.stringify(cache, null, 2))
  } catch {
    /* best-effort */
  }
}

export function getFlag(key: string): boolean {
  return !!cache.flags[key]
}

export function setFlag(key: string, value: boolean): void {
  cache.flags[key] = value
  flush()
}

export function getSavedSessions(): PersistedSession[] {
  return cache.sessions
}

export function saveSessions(sessions: PersistedSession[]): void {
  cache.sessions = sessions
  flush()
}

export function getArchivedSessions(): ArchivedSession[] {
  return cache.archived
}

export function saveArchivedSessions(archived: ArchivedSession[]): void {
  cache.archived = archived
  flush()
}

export function getWorkspaces(): Workspace[] {
  return cache.workspaces
}

export function saveWorkspaces(workspaces: Workspace[]): void {
  cache.workspaces = workspaces
  flush()
}

export function getCollapsedWorkspaces(): string[] {
  return (cache.uiState.collapsedWorkspaces as string[] | undefined) ?? []
}

export function saveCollapsedWorkspaces(ids: string[]): void {
  cache.uiState.collapsedWorkspaces = ids
  flush()
}

/** The full durable UI-state bag (read once by the renderer on mount). */
export function getUiState(): Record<string, unknown> {
  return cache.uiState
}

/** Set one durable UI-state key (merged into the bag). */
export function setUiValue(key: string, value: unknown): void {
  cache.uiState[key] = value
  flush()
}
