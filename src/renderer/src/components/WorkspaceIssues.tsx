import { useEffect, useState } from 'react'
import type { IssueSummary, TerminalSession } from '../../../shared/types'
import { useGitStatus } from '../hooks/useGitStatus'

interface Props {
  /** Workspace identity + repo path (issues are fetched via gh in this dir). */
  workspaceId: string
  path: string
  /** Sessions in this workspace, to mark issues that already have one. */
  sessions: TerminalSession[]
  /** Start (or focus) the dedicated session for an issue. */
  onStart: (workspaceId: string, number: number) => void
  /** Changes when an external event (e.g. a Done merge) should re-fetch the list. */
  refreshSignal: number
}

/**
 * Collapsible "Issues" list under a workspace: open GitHub issues via the gh
 * CLI, each with a ▶ button that spawns an isolated worktree + dedicated
 * session. Issues that already have a session show its live status instead.
 */
export function WorkspaceIssues({
  workspaceId,
  path,
  sessions,
  onStart,
  refreshSignal
}: Props): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [issues, setIssues] = useState<IssueSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** Active label filters; an issue must carry ALL selected labels to show. */
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set())
  /** Which issue's detail is expanded, and a cache of fetched bodies. */
  const [expanded, setExpanded] = useState<number | null>(null)
  const [bodies, setBodies] = useState<Record<number, string>>({})

  // Only a GitHub-backed repo has issues — don't show the section (and don't
  // imply it's a GitHub project) for a local-only repo or a non-GitHub remote.
  const { status } = useGitStatus(path)
  const isGitHub = !!status?.isRepo && /github/i.test(status.remoteUrl ?? '')

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

  // Re-fetch when an external event bumps the signal (e.g. a Done merge closed an
  // issue) — but only if this list is open and already populated, so we never
  // fetch for collapsed/never-opened workspaces. Skips the initial mount (key 0).
  useEffect(() => {
    if (refreshSignal > 0 && open && issues !== null) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  const sessionFor = (n: number): TerminalSession | undefined =>
    sessions.find((s) => s.issue?.number === n)

  const toggleDetail = async (n: number): Promise<void> => {
    if (expanded === n) {
      setExpanded(null)
      return
    }
    setExpanded(n)
    if (bodies[n] === undefined) {
      try {
        const d = await window.cockpit.issues.view(path, n)
        setBodies((m) => ({ ...m, [n]: d.body?.trim() || '(no description)' }))
      } catch {
        setBodies((m) => ({ ...m, [n]: '(failed to load issue body)' }))
      }
    }
  }

  const toggleLabel = (l: string): void =>
    setLabelFilter((prev) => {
      const next = new Set(prev)
      next.has(l) ? next.delete(l) : next.add(l)
      return next
    })

  if (!isGitHub) return null

  const allLabels = [...new Set((issues ?? []).flatMap((i) => i.labels))].sort()
  const visible = (issues ?? []).filter(
    (i) => labelFilter.size === 0 || [...labelFilter].every((l) => i.labels.includes(l))
  )

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
          {allLabels.length > 0 && (
            <div className="ws-issue-filters">
              {allLabels.map((l) => (
                <button
                  key={l}
                  className={`ws-issue-label filter ${labelFilter.has(l) ? 'active' : ''}`}
                  onClick={() => toggleLabel(l)}
                  title={labelFilter.has(l) ? 'Remove filter' : 'Filter by label'}
                >
                  {l}
                </button>
              ))}
              {labelFilter.size > 0 && (
                <button className="ws-issue-label filter" onClick={() => setLabelFilter(new Set())}>
                  × clear
                </button>
              )}
            </div>
          )}
          {issues && labelFilter.size > 0 && visible.length === 0 && (
            <div className="ws-issues-note">No issues match the selected labels.</div>
          )}
          {visible.map((i) => {
            const live = sessionFor(i.number)
            const isOpen = expanded === i.number
            return (
              <div key={i.number}>
                <div
                  className={`ws-issue ${isOpen ? 'expanded' : ''}`}
                  title={`${i.title}\n${i.labels.join(', ')}`}
                  onClick={() => toggleDetail(i.number)}
                >
                  <span
                    className="ws-issue-num link"
                    title="Open this issue on GitHub"
                    onClick={(e) => {
                      e.stopPropagation()
                      window.cockpit.openExternal(i.url)
                    }}
                  >
                    #{i.number}
                  </span>
                  <span className="ws-issue-title">{i.title}</span>
                  {live ? (
                    <span className={`dot ${live.status}`} title={`session: ${live.status}`} />
                  ) : (
                    <button
                      className="ws-git-btn"
                      title="Start a dedicated session in an isolated worktree"
                      onClick={(e) => {
                        e.stopPropagation()
                        onStart(workspaceId, i.number)
                      }}
                    >
                      ▶
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="ws-issue-detail">
                    {i.labels.length > 0 && (
                      <div className="ws-issue-detail-labels">{i.labels.join(' · ')}</div>
                    )}
                    <div className="ws-issue-detail-body">
                      {bodies[i.number] ?? 'Loading…'}
                    </div>
                    {!live && (
                      <button
                        className="ws-git-btn"
                        onClick={() => onStart(workspaceId, i.number)}
                      >
                        ▶ Start session
                      </button>
                    )}
                  </div>
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
