import { app } from 'electron'
import { join, basename, isAbsolute } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { runGit } from './git.js'
import type { IssueDoneResult } from '../shared/types.js'

/**
 * Per-issue isolation for concurrent sessions: each issue gets its own git
 * worktree + branch, so sessions never touch each other's files. Worktrees live
 * under userData (not inside the repo) so they don't pollute the main
 * checkout's `git status`.
 */

/** Where a repo's issue worktrees live (and the issue-body .md files beside them). */
export function worktreeRoot(repoDir: string): string {
  return join(app.getPath('userData'), 'worktrees', basename(repoDir))
}

function short(e: unknown): string {
  const x = e as { stderr?: string; stdout?: string; message?: string }
  return (x.stderr || x.stdout || x.message || String(e)).toString().trim().split('\n').slice(0, 5).join('\n')
}

async function hasRemote(dir: string): Promise<boolean> {
  try {
    await runGit(dir, ['remote', 'get-url', 'origin'])
    return true
  } catch {
    return false
  }
}

/**
 * True if a rebase is paused in this worktree (conflicts left for the session to
 * resolve). Checked before we try anything else on Done, so a second press while
 * the rebase is still unfinished returns a clear "finish the rebase" message
 * instead of git's cryptic "already a rebase-merge directory" error.
 */
async function rebaseInProgress(dir: string): Promise<boolean> {
  for (const marker of ['rebase-merge', 'rebase-apply']) {
    try {
      const out = (await runGit(dir, ['rev-parse', '--git-path', marker])).stdout.trim()
      if (out && existsSync(isAbsolute(out) ? out : join(dir, out))) return true
    } catch {
      /* not a repo / git too old — fall through */
    }
  }
  return false
}

/** The repo's default branch: origin/HEAD when known, else main/master, else "main". */
async function defaultBranch(dir: string): Promise<string> {
  try {
    const r = await runGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    return r.stdout.trim().replace(/^origin\//, '')
  } catch {
    /* no origin/HEAD ref */
  }
  for (const b of ['main', 'master']) {
    try {
      await runGit(dir, ['show-ref', '--verify', `refs/heads/${b}`])
      return b
    } catch {
      /* keep looking */
    }
  }
  return 'main'
}

/** Create (or reuse) the isolated worktree + branch for an issue. */
export async function createIssueWorktree(
  repoDir: string,
  issueNumber: number,
  title: string
): Promise<{ worktree: string; branch: string }> {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)
  const branch = `issue/${issueNumber}${slug ? `-${slug}` : ''}`
  const root = worktreeRoot(repoDir)
  mkdirSync(root, { recursive: true })
  const worktree = join(root, `issue-${issueNumber}`)

  // Reuse an existing worktree (e.g. re-opening an issue after an app restart).
  if (existsSync(join(worktree, '.git'))) return { worktree, branch }

  const remote = await hasRemote(repoDir)
  if (remote) {
    try {
      await runGit(repoDir, ['fetch', 'origin'], 30000)
    } catch {
      /* offline — branch from local state */
    }
  }
  const base = await defaultBranch(repoDir)
  const startPoint = remote ? `origin/${base}` : base

  let branchExists = false
  try {
    await runGit(repoDir, ['show-ref', '--verify', `refs/heads/${branch}`])
    branchExists = true
  } catch {
    /* new branch */
  }
  if (branchExists) await runGit(repoDir, ['worktree', 'add', worktree, branch], 30000)
  else await runGit(repoDir, ['worktree', 'add', '-b', branch, worktree, startPoint], 30000)
  return { worktree, branch }
}

// Finishing touches main / origin, so only one issue may land at a time.
let mergeQueue: Promise<unknown> = Promise.resolve()

/**
 * The Done flow for one issue worktree, serialized across issues:
 * committed? → fetch → rebase onto the default branch → push (or local
 * fast-forward when there's no remote) → drop the worktree + branch.
 * `dirty` and `conflict` results leave the worktree intact so the session can
 * fix things and Done can be pressed again.
 */
export function finishIssueWorktree(
  repoDir: string,
  worktree: string,
  branch: string
): Promise<IssueDoneResult> {
  const job = mergeQueue.then(() => doFinish(repoDir, worktree, branch))
  mergeQueue = job.catch(() => {})
  return job
}

async function doFinish(repoDir: string, worktree: string, branch: string): Promise<IssueDoneResult> {
  try {
    if (!existsSync(join(worktree, '.git'))) {
      return { ok: false, status: 'error', message: `worktree missing: ${worktree}` }
    }
    // 0) A rebase from a previous Done may still be paused on conflicts. Catch it
    //    first so we report "finish the rebase" rather than tripping the dirty
    //    check or restarting a rebase on top of an in-progress one.
    if (await rebaseInProgress(worktree)) {
      return {
        ok: false,
        status: 'conflict',
        message: 'A rebase is still in progress in this worktree — finish resolving the conflicts and run `git rebase --continue`.'
      }
    }
    // 1) Everything must be committed.
    const dirty = (await runGit(worktree, ['status', '--porcelain'])).stdout.trim()
    if (dirty) {
      return { ok: false, status: 'dirty', message: 'Uncommitted changes in the issue worktree.' }
    }

    const remote = await hasRemote(repoDir)
    if (remote) {
      try {
        await runGit(worktree, ['fetch', 'origin'], 30000)
      } catch {
        /* offline — rebase against what we have */
      }
    }
    const base = await defaultBranch(repoDir)
    const upstreamRef = remote ? `origin/${base}` : base

    // 2) Rebase onto the tip of the default branch. On conflict we leave the
    //    rebase in place — the session resolves it and Done is pressed again.
    try {
      await runGit(worktree, ['rebase', upstreamRef], 60000)
    } catch (e) {
      return { ok: false, status: 'conflict', message: short(e) }
    }

    const summary = (
      await runGit(worktree, ['log', '--oneline', `${upstreamRef}..HEAD`])
    ).stdout.trim()
    if (!summary) {
      return { ok: false, status: 'error', message: 'No commits on the issue branch — nothing to merge.' }
    }

    // 3) Land it.
    let note = ''
    if (remote) {
      try {
        await runGit(worktree, ['push', 'origin', `HEAD:refs/heads/${base}`], 60000)
      } catch (e) {
        return { ok: false, status: 'error', message: `push failed: ${short(e)}` }
      }
      // Bring the main checkout up to date so `main` is current after Done.
      try {
        const cur = (await runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
        if (cur === base) {
          // On the default branch → pull with --autostash so uncommitted work in
          // the main checkout doesn't block the update (it's stashed + restored).
          await runGit(repoDir, ['pull', '--autostash', 'origin', base], 60000)
        } else {
          // On another branch → fast-forward the local base ref to origin without
          // switching (fails only if base is checked out elsewhere or diverged).
          await runGit(repoDir, ['fetch', 'origin', `${base}:${base}`], 30000)
          note = ` Local ${base} fast-forwarded (checkout stays on "${cur}").`
        }
      } catch (e) {
        note = ` Local ${base} not updated (${short(e)}) — pull via the workspace git row.`
      }
    } else {
      // No remote: fast-forward the local default branch (requires it checked out + clean).
      const cur = (await runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
      if (cur !== base) {
        return {
          ok: false, status: 'error',
          message: `Main checkout is on "${cur}", not "${base}" — switch it back, then press Done again.`
        }
      }
      try {
        await runGit(repoDir, ['merge', '--ff-only', branch], 30000)
      } catch (e) {
        return { ok: false, status: 'error', message: `merge failed: ${short(e)}` }
      }
    }

    // 4) Clean up the isolation.
    try {
      await runGit(repoDir, ['worktree', 'remove', worktree], 30000)
    } catch {
      try {
        await runGit(repoDir, ['worktree', 'remove', '--force', worktree], 30000)
      } catch {
        note += ' (worktree cleanup failed — remove it via `git worktree remove`.)'
      }
    }
    try {
      await runGit(repoDir, ['branch', '-D', branch])
    } catch {
      /* already gone */
    }

    return { ok: true, status: 'merged', message: `Merged to ${base}.${note}`, summary }
  } catch (e) {
    return { ok: false, status: 'error', message: short(e) }
  }
}
