import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

/**
 * Tiny JSON-file store for things that should survive restarts.
 * Currently: user-assigned pane names, keyed by a stable name-key.
 */
interface Persisted {
  /** nameKey -> custom name. nameKey is cwd+command so names stick across restarts. */
  names: Record<string, string>
}

let cache: Persisted = { names: {} }
let filePath = ''

export function initStore(): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  filePath = join(dir, 'claude-cockpit.json')
  if (existsSync(filePath)) {
    try {
      cache = { names: {}, ...JSON.parse(readFileSync(filePath, 'utf8')) }
    } catch {
      cache = { names: {} }
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
