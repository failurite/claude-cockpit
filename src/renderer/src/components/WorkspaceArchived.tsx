import { useState } from 'react'
import type { ArchivedSessionInfo } from '../../../shared/types'

interface Props {
  /** Archived sessions to show (already filtered to this group). */
  items: ArchivedSessionInfo[]
  /** Reopen an archived session (claude --resume + reopen tabs). */
  onRestore: (archivedId: string) => void
  /** Permanently delete an archived session record. */
  onDelete: (archivedId: string) => void
}

/**
 * Collapsible "Archived" list under a workspace: sessions that were closed-and-
 * saved. Each can be reopened (▶) with its conversation + browser tabs, or
 * permanently forgotten (×). Renders nothing when the group has none.
 */
export function WorkspaceArchived({ items, onRestore, onDelete }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <div className="ws-archived">
      <button className="ws-issues-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Archived
        <span className="ws-issues-count">{items.length}</span>
      </button>
      {open && (
        <div className="ws-issues-body">
          {items.map((a) => {
            const tip =
              `Reopen ${a.name}` +
              (a.hasConversation ? ' with its conversation' : '') +
              (a.tabCount ? ` + ${a.tabCount} browser tab${a.tabCount > 1 ? 's' : ''}` : '')
            return (
              <div key={a.archivedId} className="archived-item" title={tip}>
                {a.issueNumber != null && <span className="ws-issue-num">#{a.issueNumber}</span>}
                <span className="archived-name">{a.name}</span>
                <span className="spacer" />
                <button
                  className="ws-git-btn"
                  title="Reopen with its conversation + tabs"
                  onClick={() => onRestore(a.archivedId)}
                >
                  ▶
                </button>
                <button
                  className="close-btn"
                  title="Delete this saved session permanently"
                  onClick={() => onDelete(a.archivedId)}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
