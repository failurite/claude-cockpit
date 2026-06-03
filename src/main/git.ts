import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitStatus } from '../shared/types.js'

const pexec = promisify(execFile)

/** Run a git command in `dir`. GIT_TERMINAL_PROMPT=0 so auth never hangs on a prompt. */
export function runGit(dir: string, args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
  return pexec('git', ['-C', dir, ...args], {
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 4_000_000
  })
}

/** Trim git's stderr/stdout/message into a short, user-readable line. */
function errMsg(e: unknown): string {
  const x = e as { stderr?: string; stdout?: string; message?: string }
  return (x.stderr || x.stdout || x.message || String(e)).toString().trim().split('\n').slice(0, 5).join('\n')
}

/**
 * Snapshot a directory's git state. `fetch` first runs `git fetch` so the
 * behind/unpulled count reflects the remote (network; slower) — the default
 * (false) is a fast local read.
 */
export async function gitStatus(dir: string, fetch = false): Promise<GitStatus> {
  const none: GitStatus = {
    isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, dirty: false, remoteUrl: null
  }
  try {
    await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return none
  }
  try {
    if (fetch) {
      try {
        await runGit(dir, ['fetch', '--quiet'], 30000)
      } catch {
        /* offline / no remote — fall back to local counts */
      }
    }
    const branch = (await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    let upstream: string | null = null
    let ahead = 0
    let behind = 0
    try {
      upstream = (
        await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      ).stdout.trim()
      const counts = (await runGit(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).stdout
      const [b, a] = counts.trim().split(/\s+/).map((n) => Number(n) || 0)
      behind = b
      ahead = a
    } catch {
      /* no upstream configured for this branch */
    }
    const dirty = (await runGit(dir, ['status', '--porcelain'])).stdout.trim().length > 0
    let remoteUrl: string | null = null
    try {
      remoteUrl = (await runGit(dir, ['remote', 'get-url', 'origin'])).stdout.trim()
    } catch {
      /* no origin */
    }
    return { isRepo: true, branch, upstream, ahead, behind, dirty, remoteUrl }
  } catch (e) {
    return { ...none, isRepo: true, error: errMsg(e) }
  }
}

/** `git push`. Returns the command output (success or failure) for the UI. */
export async function gitPush(dir: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await runGit(dir, ['push'], 60000)
    return { ok: true, message: (r.stderr || r.stdout).trim() || 'Pushed.' }
  } catch (e) {
    return { ok: false, message: errMsg(e) }
  }
}

/** `git pull`. Returns the command output (success or failure) for the UI. */
export async function gitPull(dir: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await runGit(dir, ['pull'], 60000)
    return { ok: true, message: (r.stdout || r.stderr).trim() || 'Up to date.' }
  } catch (e) {
    return { ok: false, message: errMsg(e) }
  }
}
