import { execFile } from 'child_process'
import { buildShellInvocation } from './platform.js'

/**
 * The installed `claude` CLI version (e.g. "2.1.233 (Claude Code)").
 *
 * Sessions are long-running processes (tmux-backed), so a session keeps running
 * whatever `claude` build it launched with — updating the CLI on disk doesn't
 * change a live session. We stamp each session with the version it launched
 * with, and compare against this to find sessions running an older build.
 *
 * Runs through a login shell so it resolves `claude` the same way a pane does
 * (a GUI-launched app has a minimal PATH; see ensureUserPath / platform.ts).
 */
let cached: string | null = null

export function cachedClaudeVersion(): string | null {
  return cached
}

/** Query `claude --version`. Cached unless `refresh` is set. */
export function claudeVersion(refresh = false): Promise<string | null> {
  if (cached && !refresh) return Promise.resolve(cached)
  const { shell, args } = buildShellInvocation(`claude --version`)
  return new Promise((resolve) => {
    execFile(shell, args, { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve(cached)
        return
      }
      const v = (stdout || '').trim().split('\n')[0]?.trim() || null
      if (v) cached = v
      resolve(cached)
    })
  })
}
