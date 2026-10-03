import { execFile } from 'child_process'
import { realpathSync } from 'fs'
import { IS_WINDOWS } from './platform.js'

/**
 * Reaps processes a session left running inside a directory Cockpit owns.
 *
 * Why this exists: a session's `claude` runs under tmux, so anything it spawns
 * (vite, npm, playwright…) is parented by the tmux server — NOT by our pty. When
 * the pane closes we kill the pty and the tmux session, but those grandchildren
 * survive, detached. In practice that leaked 82 processes holding 28+ dev-server
 * ports, the oldest alive for 76 days.
 *
 * Attribution is by **current working directory**, which is the only reliable
 * link back to the session once the process tree is broken. That's also why this
 * is deliberately scoped to per-issue worktrees under our userData: those
 * directories belong to exactly one session, so anything running in one is ours
 * to clean up. We never reap by a shared workspace folder (e.g. ~/code/house) —
 * the user's own long-running servers live there too.
 */

/** pid → cwd for every process we can see, via ONE `lsof` call (per-pid is far slower). */
async function cwdByPid(): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (IS_WINDOWS) return out // no lsof; Windows sessions aren't tmux-backed anyway
  const stdout = await new Promise<string>((resolve) => {
    // -d cwd: only the cwd descriptor. -Fpn: machine-readable pid/name records.
    execFile('lsof', ['-d', 'cwd', '-Fpn'], { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 }, (_e, so) =>
      resolve(so || '')
    )
  })
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0
    else if (line.startsWith('n') && pid) out.set(pid, line.slice(1))
  }
  return out
}

/** True if `child` is at or under `dir`. */
function isUnder(child: string, dir: string): boolean {
  const d = dir.endsWith('/') ? dir : `${dir}/`
  return child === dir || child.startsWith(d)
}

/**
 * `lsof` reports the RESOLVED physical path (/private/var/…), while the paths we
 * hold can still contain symlinks (/var/…, /tmp/…). Comparing them raw silently
 * matches nothing, so resolve our side first.
 */
function resolved(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir // gone already — the raw string is the best we can do
  }
}

/** pids whose cwd is at/under any of `dirs` (never our own process or its parent). */
export async function pidsUnder(dirs: string[]): Promise<number[]> {
  if (!dirs.length) return []
  const targets = dirs.map(resolved)
  const map = await cwdByPid()
  const mine = new Set([process.pid, process.ppid])
  const hits: number[] = []
  for (const [pid, cwd] of map) {
    if (mine.has(pid)) continue
    if (targets.some((d) => isUnder(cwd, d))) hits.push(pid)
  }
  return hits
}

/**
 * TERM (then KILL) every process running inside `dirs`. Resolves with how many
 * were signalled. Best-effort: a process that already exited is not an error.
 */
export async function reapUnder(dirs: string[]): Promise<number> {
  const pids = await pidsUnder(dirs)
  if (!pids.length) return 0
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  // Give them a moment to shut down cleanly, then force the stragglers.
  await new Promise((r) => setTimeout(r, 2500))
  for (const pid of pids) {
    try {
      process.kill(pid, 0) // throws if gone
      process.kill(pid, 'SIGKILL')
    } catch {
      /* exited on TERM */
    }
  }
  return pids.length
}
