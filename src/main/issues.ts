import { execFile } from 'child_process'
import { promisify } from 'util'
import type { IssueSummary } from '../shared/types.js'

const pexec = promisify(execFile)

/**
 * Run the GitHub CLI in a repo dir. Reuses the user's existing `gh` auth —
 * Cockpit never stores tokens. Non-interactive flags so nothing ever prompts.
 */
function gh(dir: string, args: string[], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> {
  return pexec('gh', args, {
    cwd: dir,
    timeout: timeoutMs,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    maxBuffer: 4_000_000
  })
}

/** Trim gh's stderr/stdout/message into a short, user-readable line. */
function errMsg(e: unknown): string {
  const x = e as { stderr?: string; stdout?: string; message?: string }
  return (x.stderr || x.stdout || x.message || String(e))
    .toString()
    .trim()
    .split('\n')
    .slice(0, 6)
    .join('\n')
}

/**
 * Create a new GitHub repo under the authenticated account and clone it into
 * `parentDir/<name>`. Uses the user's existing gh auth (needs the `repo` scope).
 * Returns a short message on success or failure for the dialog.
 */
export async function createRepo(
  parentDir: string,
  name: string,
  opts: { private: boolean; description?: string }
): Promise<{ ok: boolean; message: string }> {
  const args = ['repo', 'create', name, opts.private ? '--private' : '--public', '--clone']
  if (opts.description?.trim()) args.push('--description', opts.description.trim())
  try {
    const r = await gh(parentDir, args, 120000)
    return { ok: true, message: (r.stderr || r.stdout).trim() || 'Created.' }
  } catch (e) {
    return { ok: false, message: errMsg(e) }
  }
}

/** True if gh is installed and authenticated (issues UI hides itself otherwise). */
export async function ghAvailable(dir: string): Promise<boolean> {
  try {
    await gh(dir, ['auth', 'status'], 8000)
    return true
  } catch {
    return false
  }
}

/** Open issues for the repo at `dir`. */
export async function listIssues(dir: string): Promise<IssueSummary[]> {
  const r = await gh(dir, [
    'issue', 'list', '--state', 'open', '--limit', '50',
    '--json', 'number,title,url,labels,updatedAt'
  ])
  const raw = JSON.parse(r.stdout || '[]') as Array<{
    number: number
    title: string
    url: string
    labels?: Array<{ name: string }>
    updatedAt: string
  }>
  return raw.map((i) => ({
    number: i.number,
    title: i.title,
    url: i.url,
    labels: (i.labels ?? []).map((l) => l.name),
    updatedAt: i.updatedAt
  }))
}

/** Full detail for one issue — body + comments, for the session's kickoff context. */
export async function viewIssue(
  dir: string,
  number: number
): Promise<{
  number: number
  title: string
  body: string
  url: string
  comments: { author: string; body: string }[]
}> {
  const r = await gh(dir, [
    'issue', 'view', String(number),
    '--json', 'number,title,body,url,comments'
  ])
  const raw = JSON.parse(r.stdout) as {
    number: number
    title: string
    body: string
    url: string
    comments?: Array<{ author?: { login?: string }; body?: string }>
  }
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    comments: (raw.comments ?? []).map((c) => ({
      author: c.author?.login ?? 'unknown',
      body: c.body ?? ''
    }))
  }
}

/** Close an issue with a closing comment (the Done flow's last step). */
export async function closeIssue(dir: string, number: number, comment: string): Promise<void> {
  await gh(dir, ['issue', 'close', String(number), '--comment', comment], 30000)
}
