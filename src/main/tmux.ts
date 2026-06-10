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
  // No tmux on Windows — short-circuit so we never probe POSIX paths or `which`.
  // The dev session falls back to the ephemeral + `claude --resume` path instead.
  if (process.platform === 'win32') return (cachedBin = null)
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

/** Single-quote a string for the shell (also used for claude kickoff prompts). */
export function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * The shell command that attaches to the persistent dev tmux session, creating it
 * (running `claude <flags>`) if it doesn't exist. `-A` = attach-if-exists. Because
 * the tmux *server* outlives cockpit, claude survives app restarts; we just re-attach.
 * NB: flags only apply when the session is first created — re-attach ignores them.
 */
export function devLaunchCommand(cwd: string, claudeArgs: string[] = []): string {
  const cmd = ['claude', ...claudeArgs].join(' ').trim()
  return `tmux new-session -A -s ${DEV_TMUX_NAME} -c ${sq(cwd)} ${cmd}`
}

/**
 * Turn on tmux mouse mode for one cockpit session (session-scoped — never `-g`,
 * so the user's own tmux sessions are untouched). Without it, tmux translates
 * trackpad wheel into Up/Down arrows for alt-screen apps, which makes scrolling
 * in a Claude pane cycle prompt history instead of scrolling the transcript.
 */
export function enableMouse(name: string): void {
  const bin = tmuxBin()
  if (!bin || !name.startsWith(TMUX_PREFIX)) return
  try {
    execFileSync(bin, ['set-option', '-t', name, 'mouse', 'on'], { stdio: 'ignore' })
  } catch {
    /* session not up yet — caller retries */
  }
}

/**
 * The `claude …` command the live dev tmux session was started with, or null if
 * it isn't running. `new-session -A` re-attach ignores flags, so a long-lived
 * session keeps its original command — we compare against this to detect drift.
 */
export function devSessionStartCommand(): string | null {
  const bin = tmuxBin()
  if (!bin) return null
  try {
    const out = execFileSync(
      bin,
      ['list-panes', '-t', DEV_TMUX_NAME, '-F', '#{pane_start_command}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    return out.split('\n')[0] || null
  } catch {
    return null // session not running
  }
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
