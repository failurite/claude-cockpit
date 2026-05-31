import { useState } from 'react'
import type { SessionStatus, TerminalSession } from '../../../shared/types'

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting…',
  idle: 'idle',
  working: 'working',
  waiting: 'needs you',
  exited: 'exited'
}

interface Props {
  sessions: TerminalSession[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onClose: (id: string) => void
  onRename: (id: string, name: string) => void
}

export function Sidebar({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onClose,
  onRename
}: Props): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const startEdit = (s: TerminalSession): void => {
    setEditingId(s.id)
    setDraft(s.name)
  }
  const commit = (): void => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">claude-cockpit</span>
        <button className="new-btn" title="New session" onClick={onCreate}>
          +
        </button>
      </div>
      <ul className="session-list">
        {sessions.map((s) => (
          <li
            key={s.id}
            className={`session-item ${s.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(s.id)}
          >
            <span className={`dot ${s.status}`} title={s.status} />
            <div className="session-main">
              {editingId === s.id ? (
                <input
                  className="rename-input"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="session-name-row">
                  <span
                    className="session-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      startEdit(s)
                    }}
                    title="Double-click to rename"
                  >
                    {s.name}
                  </span>
                  {s.usingChrome && (
                    <span className="chrome-chip" title={`Driving Chrome: ${s.chromeActivity ?? ''}`}>
                      🌐
                    </span>
                  )}
                </span>
              )}
              <span className="session-sub">
                {s.usingChrome && s.chromeActivity
                  ? s.chromeActivity
                  : STATUS_LABEL[s.status]}
                {s.subagentCount > 0 && ` · ⛓ ${s.subagentCount}`}
              </span>
            </div>
            <button
              className="close-btn"
              title="Close session"
              onClick={(e) => {
                e.stopPropagation()
                onClose(s.id)
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-foot">
        <button className="ghost-btn" onClick={onCreate}>
          + New Claude session
        </button>
      </div>
    </aside>
  )
}
