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
}

let cache: Persisted = { names: {}, sessions: [] }
let filePath = ''

export function initStore(): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  filePath = join(dir, 'claude-cockpit.json')
  if (existsSync(filePath)) {
    try {
      cache = { names: {}, sessions: [], ...JSON.parse(readFileSync(filePath, 'utf8')) }
    } catch {
      cache = { names: {}, sessions: [] }
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

export function getSavedSessions(): PersistedSession[] {
  return cache.sessions
}

export function saveSessions(sessions: PersistedSession[]): void {
  cache.sessions = sessions
  flush()
}
