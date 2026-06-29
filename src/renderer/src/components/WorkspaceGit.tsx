import { useState } from 'react'
import { useGitStatus } from '../hooks/useGitStatus'

/**
 * Compact git row for a workspace: branch, ↑unpushed / ↓unpulled, dirty marker,
 * and manual Pull / Push / fetch-refresh. Renders nothing if the folder isn't a
 * git repo. Polls (via useGitStatus) so a repo that's created/pushed after the
 * row mounts still appears. The unpulled count is only accurate after a fetch.
 */
export function WorkspaceGit({ path }: { path: string }): JSX.Element | null {
  const { status: st, reload } = useGitStatus(path)
  const [busy, setBusy] = useState<'' | 'pull' | 'push' | 'refresh'>('')
  const [msg, setMsg] = useState<string | null>(null)

  if (!st || !st.isRepo) return null

  const run = async (
    kind: 'pull' | 'push' | 'refresh',
    fn: () => Promise<{ ok: boolean; message: string } | void>
  ): Promise<void> => {
    setBusy(kind)
    setMsg(null)
    const r = await fn()
    if (r && 'message' in r) setMsg(r.message)
    await reload(true)
    setBusy('')
  }

  return (
    <div className="ws-git">
      <span className="ws-git-branch" title={st.remoteUrl ?? st.upstream ?? 'no remote'}>
        ⎇ {st.branch ?? '—'}
        {st.dirty && <span className="ws-git-dirty" title="uncommitted changes">●</span>}
      </span>
      {st.ahead > 0 && (
        <span className="ws-git-count ahead" title={`${st.ahead} unpushed commit(s)`}>
          ↑{st.ahead}
        </span>
      )}
      {st.behind > 0 && (
        <span className="ws-git-count behind" title={`${st.behind} unpulled commit(s)`}>
          ↓{st.behind}
        </span>
      )}
      {st.upstream && st.ahead === 0 && st.behind === 0 && (
        <span className="ws-git-count synced" title="in sync with upstream">
          ✓
        </span>
      )}
      <span className="spacer" />
      <button
        className="ws-git-btn"
        disabled={!!busy || !st.upstream || st.behind === 0}
        onClick={() => run('pull', () => window.cockpit.git.pull(path))}
        title="git pull"
      >
        {busy === 'pull' ? '…' : 'Pull'}
      </button>
      <button
        className="ws-git-btn"
        disabled={!!busy || st.ahead === 0}
        onClick={() => run('push', () => window.cockpit.git.push(path))}
        title="git push"
      >
        {busy === 'push' ? '…' : 'Push'}
      </button>
      <button
        className="ws-git-btn"
        disabled={!!busy}
        onClick={() => run('refresh', async () => undefined)}
        title="Fetch &amp; refresh"
      >
        {busy === 'refresh' ? '…' : '⟳'}
      </button>
      {msg && (
        <div className="ws-git-msg" title={msg}>
          {msg.split('\n')[0]}
        </div>
      )}
    </div>
  )
}
