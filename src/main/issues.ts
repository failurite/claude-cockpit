import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { net } from 'electron'
import type { IssueSummary, RepoLabel } from '../shared/types.js'

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

/**
 * Rename the GitHub repo of the checkout at `dir` (renames on GitHub and updates
 * this checkout's `origin`). The local folder + Cockpit workspace name are left
 * as-is. Needs gh auth with push access to the repo.
 */
export async function renameRepo(
  dir: string,
  newName: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await gh(dir, ['repo', 'rename', newName, '--yes'], 30000)
    return { ok: true, message: (r.stdout || r.stderr).trim() || 'Renamed.' }
  } catch (e) {
    return { ok: false, message: errMsg(e) }
  }
}

/** Open labels defined on the repo, for the New-issue label picker. */
export async function listLabels(dir: string): Promise<RepoLabel[]> {
  try {
    const r = await gh(dir, ['label', 'list', '--limit', '200', '--json', 'name,color,description'])
    const raw = JSON.parse(r.stdout || '[]') as Array<{
      name: string
      color?: string
      description?: string
    }>
    return raw.map((l) => ({ name: l.name, color: l.color || '', description: l.description || '' }))
  } catch {
    return []
  }
}

/**
 * Create an issue. Body is passed via a temp file (`--body-file`) so long,
 * multiline markdown (with pasted-image links) survives without arg/quoting
 * limits. Returns the new issue's URL.
 */
export async function createIssue(
  dir: string,
  opts: { title: string; body: string; labels: string[] }
): Promise<{ ok: boolean; url?: string; message?: string }> {
  const tmp = join(tmpdir(), `cockpit-issue-${randomUUID()}.md`)
  try {
    writeFileSync(tmp, opts.body ?? '')
    const args = ['issue', 'create', '--title', opts.title, '--body-file', tmp]
    for (const l of opts.labels) args.push('--label', l)
    const r = await gh(dir, args, 60000)
    // gh prints the created issue URL as the last stdout line.
    const url = (r.stdout || '').trim().split('\n').pop()
    return { ok: true, url: url || undefined }
  } catch (e) {
    return { ok: false, message: errMsg(e) }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* already gone */
    }
  }
}

/**
 * Upload an image to GitHub's user-attachments store (the same target the web
 * composer uses when you paste) and return its `github.com/user-attachments/...`
 * URL to embed in an issue body. Uses the user's gh token; endpoint is
 * undocumented but works with a Bearer token.
 */
export async function uploadIssueImage(
  dir: string,
  opts: { name: string; contentType: string; dataBase64: string }
): Promise<{ ok: boolean; url?: string; message?: string }> {
  try {
    const repoId = (await gh(dir, ['repo', 'view', '--json', 'id', '--jq', '.id'])).stdout.trim()
    const token = (await gh(dir, ['auth', 'token'])).stdout.trim()
    if (!repoId || !token) return { ok: false, message: 'Not signed in to GitHub (gh).' }
    const contentType = opts.contentType || 'image/png'
    const url =
      `https://uploads.github.com/user-attachments/assets` +
      `?name=${encodeURIComponent(opts.name || 'image.png')}` +
      `&content_type=${encodeURIComponent(contentType)}` +
      `&repository_id=${encodeURIComponent(repoId)}`
    const res = await net.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': contentType },
      body: Buffer.from(opts.dataBase64, 'base64')
    })
    if (!res.ok) return { ok: false, message: `Image upload failed (HTTP ${res.status}).` }
    const json = (await res.json()) as { url?: string }
    return json?.url ? { ok: true, url: json.url } : { ok: false, message: 'No URL in upload response.' }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
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
