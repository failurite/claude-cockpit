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

/** Full detail for one issue (body included, for the session's kickoff context). */
export async function viewIssue(
  dir: string,
  number: number
): Promise<{ number: number; title: string; body: string; url: string }> {
  const r = await gh(dir, ['issue', 'view', String(number), '--json', 'number,title,body,url'])
  return JSON.parse(r.stdout)
}

/** Close an issue with a closing comment (the Done flow's last step). */
export async function closeIssue(dir: string, number: number, comment: string): Promise<void> {
  await gh(dir, ['issue', 'close', String(number), '--comment', comment], 30000)
}
