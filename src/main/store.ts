import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

/** A pane as persisted to disk so it can be restored on next launch. */
export interface PersistedSession {
  name: string
  cwd: string
  command: string
  kind: 'normal' | 'dev'
  /** Claude's session id, so we can `claude --resume <id>` to restore the conversation. */
  claudeSessionId: string | null
}

/**
 * Tiny JSON-file store for things that should survive restarts:
 *   - user-assigned pane names (keyed by a stable name-key)
 *   - the set of open panes, for restore-on-launch
 */
interface Persisted {
  names: Record<string, string>
  sessions: PersistedSession[]
  /** One-time flags, e.g. whether we've already auto-installed status hooks. */
  flags: Record<string, boolean>
}

let cache: Persisted = { names: {}, sessions: [], flags: {} }
let filePath = ''

export function initStore(): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  filePath = join(dir, 'claude-cockpit.json')
  if (existsSync(filePath)) {
    try {
      cache = { names: {}, sessions: [], flags: {}, ...JSON.parse(readFileSync(filePath, 'utf8')) }
    } catch {
      cache = { names: {}, sessions: [], flags: {} }
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

export function getSavedName(nameKey: string): string | undefined {
  return cache.names[nameKey]
}

export function saveName(nameKey: string, name: string): void {
  cache.names[nameKey] = name
  flush()
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
