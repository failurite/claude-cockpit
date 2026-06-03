import { useState } from 'react'
import type { IssueSummary, TerminalSession } from '../../../shared/types'

interface Props {
  /** Workspace identity + repo path (issues are fetched via gh in this dir). */
  workspaceId: string
  path: string
  /** Sessions in this workspace, to mark issues that already have one. */
  sessions: TerminalSession[]
  /** Start (or focus) the dedicated session for an issue. */
  onStart: (workspaceId: string, number: number) => void
}

/**
 * Collapsible "Issues" list under a workspace: open GitHub issues via the gh
 * CLI, each with a ▶ button that spawns an isolated worktree + dedicated
 * session. Issues that already have a session show its live status instead.
 */
export function WorkspaceIssues({ workspaceId, path, sessions, onStart }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [issues, setIssues] = useState<IssueSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setIssues(await window.cockpit.issues.list(path))
    } catch {
      setError('Issues unavailable — needs the gh CLI, authenticated, and a GitHub remote.')
    }
    setLoading(false)
  }

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && issues === null) void refresh()
  }

  const sessionFor = (n: number): TerminalSession | undefined =>
    sessions.find((s) => s.issue?.number === n)

  return (
    <div className="ws-issues">
      <button className="ws-issues-toggle" onClick={toggle}>
        {open ? '▾' : '▸'} Issues
        {issues && issues.length > 0 && <span className="ws-issues-count">{issues.length}</span>}
      </button>
      {open && (
        <div className="ws-issues-body">
          {loading && <div className="ws-issues-note">Loading…</div>}
          {error && <div className="ws-issues-note">{error}</div>}
          {issues && issues.length === 0 && !loading && (
            <div className="ws-issues-note">No open issues 🎉</div>
          )}
          {issues?.map((i) => {
            const live = sessionFor(i.number)
            return (
              <div key={i.number} className="ws-issue" title={i.url}>
                <span className="ws-issue-num">#{i.number}</span>
                <span className="ws-issue-title">{i.title}</span>
                {i.labels.slice(0, 2).map((l) => (
                  <span key={l} className="ws-issue-label">
                    {l}
                  </span>
                ))}
                {live ? (
                  <span className={`dot ${live.status}`} title={`session: ${live.status}`} />
                ) : (
                  <button
                    className="ws-git-btn"
                    title="Start a dedicated session in an isolated worktree"
                    onClick={() => onStart(workspaceId, i.number)}
                  >
                    ▶
                  </button>
                )}
              </div>
            )
          })}
          {!loading && (
            <button className="ws-git-btn ws-issues-refresh" onClick={refresh}>
              ⟳ refresh
            </button>
          )}
        </div>
      )}
    </div>
  )
}
