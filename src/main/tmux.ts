import { execFileSync } from 'child_process'
import { existsSync } from 'fs'

/** All cockpit-created tmux sessions share this prefix so we can find/clean only ours. */
export const TMUX_PREFIX = 'cockpit-'
/** The single persistent dev session name. */
export const DEV_TMUX_NAME = 'cockpit-dev'

let cachedBin: string | null | undefined

/** Resolve the tmux binary (absolute path), or null if not installed. */
export function tmuxBin(): string | null {
  if (cachedBin !== undefined) return cachedBin
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
    if (existsSync(p)) return (cachedBin = p)
  }
  try {
    const found = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim()
    return (cachedBin = found || null)
  } catch {
    return (cachedBin = null)
  }
}

export function isTmuxAvailable(): boolean {
  return tmuxBin() !== null
}

function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * The shell command that attaches to the persistent dev tmux session, creating it
 * (running `claude`) if it doesn't exist. `-A` = attach-if-exists. Because the tmux
 * *server* outlives cockpit, claude survives app restarts; we just re-attach.
 */
export function devLaunchCommand(cwd: string): string {
  return `tmux new-session -A -s ${DEV_TMUX_NAME} -c ${sq(cwd)} claude`
}

/** Names of currently-live cockpit-owned tmux sessions (empty if no server). */
export function listCockpitSessions(): string[] {
  const bin = tmuxBin()
  if (!bin) return []
  try {
    const out = execFileSync(bin, ['ls', '-F', '#{session_name}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(TMUX_PREFIX))
  } catch {
    // tmux exits non-zero when no server is running.
    return []
  }
}

/** Kill one cockpit session by name (no-op for non-cockpit names, as a safety guard). */
export function killCockpitSession(name: string): void {
  const bin = tmuxBin()
  if (!bin || !name.startsWith(TMUX_PREFIX)) return
  try {
    execFileSync(bin, ['kill-session', '-t', name], { stdio: 'ignore' })
  } catch {
    /* already gone */
  }
}

/** Kill every cockpit-owned tmux session. */
export function killAllCockpitSessions(): void {
  for (const name of listCockpitSessions()) killCockpitSession(name)
}
