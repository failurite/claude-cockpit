import { useState } from 'react'
import type { SessionStatus, TerminalSession, Workspace } from '../../../shared/types'
import { WorkspaceGit } from './WorkspaceGit'

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting…',
  idle: 'idle',
  working: 'working',
  waiting: 'needs you',
  exited: 'exited'
}

interface Props {
  sessions: TerminalSession[]
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onRename: (id: string, name: string) => void
  /** Create a session inheriting a workspace's default options. */
  onNewSession: (workspaceId: string) => void
  /** Create a session in a workspace with custom (overridden) options. */
  onCustomSession: (workspaceId: string) => void
  /** Define a brand-new workspace (folder + defaults). */
  onNewWorkspace: () => void
  onEditWorkspace: (ws: Workspace) => void
  onDeleteWorkspace: (id: string) => void
  onOpenSettings: () => void
}

export function Sidebar({
  sessions,
  workspaces,
  activeId,
  onSelect,
  onClose,
  onRename,
  onNewSession,
  onCustomSession,
  onNewWorkspace,
  onEditWorkspace,
  onDeleteWorkspace,
  onOpenSettings
}: Props): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const startEdit = (s: TerminalSession): void => {
    setEditingId(s.id)
    setDraft(s.name)
  }
  const commit = (): void => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }
  const toggleCollapse = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const ungrouped = sessions.filter((s) => s.kind !== 'dev' && !s.workspaceId)
  const dev = sessions.filter((s) => s.kind === 'dev')

  const renderItem = (s: TerminalSession): JSX.Element => (
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
            {s.kind === 'dev' && (
              <span className="dev-chip" title="Works on claude-cockpit itself">
                🛠
              </span>
            )}
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
          {s.usingChrome && s.chromeActivity ? s.chromeActivity : STATUS_LABEL[s.status]}
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
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">claude-cockpit</span>
        <div className="head-actions">
          <button className="new-btn" title="Settings" onClick={onOpenSettings}>
            ⚙
          </button>
          <button className="new-btn" title="New workspace" onClick={onNewWorkspace}>
            +
          </button>
        </div>
      </div>

      <div className="ws-scroll">
        {workspaces.map((ws) => {
          const items = sessions.filter((s) => s.workspaceId === ws.id)
          const isCollapsed = collapsed.has(ws.id)
          return (
            <div className="ws-group" key={ws.id}>
              <div className="ws-header">
                <button className="ws-chevron" onClick={() => toggleCollapse(ws.id)}>
                  {isCollapsed ? '▸' : '▾'}
                </button>
                <span className="ws-name" title={ws.path}>
                  {ws.name}
                </span>
                <button
                  className="ws-btn"
                  title="New session (workspace defaults)"
                  onClick={() => onNewSession(ws.id)}
                >
                  +
                </button>
                <div className="ws-menu-wrap">
                  <button
                    className="ws-btn"
                    title="More…"
                    onClick={() => setMenuFor(menuFor === ws.id ? null : ws.id)}
                  >
                    ▾
                  </button>
                  {menuFor === ws.id && (
                    <>
                      <div className="menu-overlay" onClick={() => setMenuFor(null)} />
                      <div className="ws-menu">
                        <button
                          onClick={() => {
                            setMenuFor(null)
                            onCustomSession(ws.id)
                          }}
                        >
                          New session (custom settings…)
                        </button>
                        <button
                          onClick={() => {
                            setMenuFor(null)
                            onEditWorkspace(ws)
                          }}
                        >
                          Edit workspace…
                        </button>
                        <button
                          className="danger"
                          onClick={() => {
                            setMenuFor(null)
                            onDeleteWorkspace(ws.id)
                          }}
                        >
                          Remove workspace
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
              {!isCollapsed && <WorkspaceGit path={ws.path} />}
              {!isCollapsed && (
                <ul className="session-list">
                  {items.length ? (
                    items.map(renderItem)
                  ) : (
                    <li className="ws-empty">No sessions yet</li>
                  )}
                </ul>
              )}
            </div>
          )
        })}

        {(ungrouped.length > 0 || dev.length > 0) && (
          <div className="ws-group">
            <div className="ws-header">
              <span className="ws-chevron-spacer" />
              <span className="ws-name muted">Other</span>
            </div>
            {/* The dev session's cwd is the cockpit repo — show its git status too. */}
            {dev[0] && <WorkspaceGit path={dev[0].cwd} />}
            <ul className="session-list">{[...dev, ...ungrouped].map(renderItem)}</ul>
          </div>
        )}
      </div>

      <div className="sidebar-foot">
        <button className="ghost-btn" onClick={onNewWorkspace}>
          + New workspace
        </button>
      </div>
    </aside>
  )
}
