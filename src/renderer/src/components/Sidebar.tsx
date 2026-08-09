import { useRef, useState } from 'react'
import type {
  ArchivedSessionInfo,
  SessionStatus,
  TerminalSession,
  Workspace
} from '../../../shared/types'
import { COCKPIT_WORKSPACE_ID } from '../../../shared/types'
import { SystemStats } from './SystemStats'
import { WorkspaceGit } from './WorkspaceGit'
import { WorkspaceIssues } from './WorkspaceIssues'
import { WorkspaceArchived } from './WorkspaceArchived'

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
  /** Relaunch a session's claude process in place (resumes the conversation). */
  onRestart: (id: string) => void
  /** Archive a session (close but save to reopen later). */
  onArchive: (id: string) => void
  /** Archived (closed-but-saved) sessions across all workspaces. */
  archived: ArchivedSessionInfo[]
  onRestoreArchived: (archivedId: string) => void
  onDeleteArchived: (archivedId: string) => void
  onRename: (id: string, name: string) => void
  /** Create a session inheriting a workspace's default options. */
  onNewSession: (workspaceId: string) => void
  /** Create a session in a workspace with custom (overridden) options. */
  onCustomSession: (workspaceId: string) => void
  /** Define a brand-new workspace (folder + defaults). */
  onNewWorkspace: () => void
  onEditWorkspace: (ws: Workspace) => void
  /** Rename a workspace in place (double-click its name). */
  onRenameWorkspace: (id: string, name: string) => void
  /** Rename the workspace's GitHub repo (gh repo rename). */
  onRenameRepo: (ws: Workspace) => void
  /** Open the New GitHub issue dialog for this workspace. */
  onNewIssue: (ws: Workspace) => void
  onDeleteWorkspace: (id: string) => void
  /** Drag-reorder user workspaces (ids in the new order). */
  onReorderWorkspaces: (orderedIds: string[]) => void
  /** Drag-reorder a workspace's sessions (that workspace's session ids in the new order). */
  onReorderSessions: (orderedIds: string[]) => void
  /** Start (or focus) the dedicated session for a GitHub issue. */
  onStartIssue: (workspaceId: string, number: number) => void
  /** Incremented after a Done merge so each open Issues list re-fetches. */
  issuesRefreshKey: number
  onOpenSettings: () => void
  /** A locally-built update is staged; show the restart button. */
  updateStaged: boolean
  /** Restart into the staged update. */
  onApplyUpdate: () => void
  /** Current width in px (user-resizable via the drag handle in App). */
  width: number
  /** Collapse the sidebar to a thin rail. */
  onCollapse: () => void
}

export function Sidebar({
  sessions,
  workspaces,
  activeId,
  onSelect,
  onClose,
  onRestart,
  onArchive,
  archived,
  onRestoreArchived,
  onDeleteArchived,
  onRename,
  onNewSession,
  onCustomSession,
  onNewWorkspace,
  onEditWorkspace,
  onRenameWorkspace,
  onRenameRepo,
  onNewIssue,
  onDeleteWorkspace,
  onReorderWorkspaces,
  onReorderSessions,
  onStartIssue,
  issuesRefreshKey,
  onOpenSettings,
  updateStaged,
  onApplyUpdate,
  width,
  onCollapse
}: Props): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Collapsed (minimized) workspaces, persisted across app reloads via localStorage.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('collapsedWorkspaces')
      return new Set<string>(raw ? JSON.parse(raw) : [])
    } catch {
      return new Set<string>()
    }
  })
  const [menuFor, setMenuFor] = useState<string | null>(null)
  // Inline workspace rename (kept separate from session rename so ids can't clash).
  const [editingWsId, setEditingWsId] = useState<string | null>(null)
  const [wsDraft, setWsDraft] = useState('')
  // Right-click context menu on a session: the session + where to draw the menu.
  const [ctxMenu, setCtxMenu] = useState<{ s: TerminalSession; x: number; y: number } | null>(null)
  // Drag-to-reorder state: what's being dragged + which row it's hovering over.
  const [drag, setDrag] = useState<
    | { kind: 'ws'; id: string }
    | { kind: 'session'; id: string; workspaceId: string | null }
    | null
  >(null)
  const [dropId, setDropId] = useState<string | null>(null)
  // Disambiguate single-click (open repo) from double-click (rename) on the ws name.
  const nameClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const endDrag = (): void => {
    setDrag(null)
    setDropId(null)
  }
  /** Move `draggedId` to just before `targetId` within `ids`; returns the new order. */
  const moved = (ids: string[], draggedId: string, targetId: string): string[] => {
    const next = ids.filter((id) => id !== draggedId)
    const ti = next.indexOf(targetId)
    next.splice(ti < 0 ? next.length : ti, 0, draggedId)
    return next
  }
  const dropWorkspace = (targetId: string): void => {
    if (drag?.kind !== 'ws' || drag.id === targetId || targetId === COCKPIT_WORKSPACE_ID) return
    const ids = workspaces.filter((w) => w.id !== COCKPIT_WORKSPACE_ID).map((w) => w.id)
    onReorderWorkspaces(moved(ids, drag.id, targetId))
  }
  const dropSession = (target: TerminalSession): void => {
    if (drag?.kind !== 'session' || drag.id === target.id || drag.workspaceId !== target.workspaceId)
      return
    const ids = sessions.filter((s) => s.workspaceId === target.workspaceId).map((s) => s.id)
    onReorderSessions(moved(ids, drag.id, target.id))
  }

  const startEdit = (s: TerminalSession): void => {
    setEditingId(s.id)
    setDraft(s.name)
  }
  const commit = (): void => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }
  const startWsEdit = (ws: Workspace): void => {
    setEditingWsId(ws.id)
    setWsDraft(ws.name)
  }
  const commitWs = (): void => {
    if (editingWsId && wsDraft.trim()) onRenameWorkspace(editingWsId, wsDraft.trim())
    setEditingWsId(null)
  }
  /** Open the workspace's repo (origin remote) in the system browser. */
  const openRepo = async (path: string): Promise<void> => {
    const st = await window.cockpit.git.status(path)
    if (!st.remoteUrl) return
    let url = st.remoteUrl.trim()
    const ssh = url.match(/^git@([^:]+):(.+?)(\.git)?$/)
    if (ssh) url = `https://${ssh[1]}/${ssh[2]}`
    else url = url.replace(/\.git$/, '')
    if (url.startsWith('https://')) window.cockpit.openExternal(url)
  }

  const toggleCollapse = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      try {
        localStorage.setItem('collapsedWorkspaces', JSON.stringify([...next]))
      } catch {
        /* storage unavailable — collapse still works this session */
      }
      return next
    })

  // Sessions whose workspace isn't shown (ad-hoc, or the Cockpit workspace when hidden).
  const ungrouped = sessions.filter((s) => !workspaces.some((w) => w.id === s.workspaceId))
  const archivedUngrouped = archived.filter((a) => !workspaces.some((w) => w.id === a.workspaceId))

  const renderItem = (s: TerminalSession): JSX.Element => {
    const isDropTarget =
      drag?.kind === 'session' && drag.id !== s.id && drag.workspaceId === s.workspaceId && dropId === s.id
    return (
    <li
      key={s.id}
      className={`session-item ${s.id === activeId ? 'active' : ''} ${isDropTarget ? 'drop-target' : ''} ${
        drag?.kind === 'session' && drag.id === s.id ? 'dragging' : ''
      }`}
      onClick={() => onSelect(s.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        setCtxMenu({ s, x: e.clientX, y: e.clientY })
      }}
      onDragOver={(e) => {
        if (drag?.kind === 'session' && drag.id !== s.id && drag.workspaceId === s.workspaceId) {
          e.preventDefault()
          setDropId(s.id)
        }
      }}
      onDragLeave={() => setDropId((d) => (d === s.id ? null : d))}
      onDrop={(e) => {
        e.preventDefault()
        dropSession(s)
        endDrag()
      }}
    >
      <span
        className="drag-grip"
        draggable
        title="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
        onDragStart={(e) => {
          setDrag({ kind: 'session', id: s.id, workspaceId: s.workspaceId })
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', s.id)
        }}
        onDragEnd={endDrag}
      >
        ⠿
      </span>
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
            {s.issue && (
              <span
                className="issue-chip link"
                title={`Open on GitHub · branch ${s.issue.branch}`}
                onClick={(e) => {
                  e.stopPropagation()
                  window.cockpit.openExternal(s.issue!.url)
                }}
              >
                #{s.issue.number}
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
      {/* Archive lives in the right-click menu — the row stays uncluttered. */}
      <button
        className="close-btn"
        title="Close session (right-click for Archive)"
        onClick={(e) => {
          e.stopPropagation()
          onClose(s.id)
        }}
      >
        ×
      </button>
    </li>
    )
  }

  return (
    <aside className="sidebar" style={{ width, minWidth: width }}>
      <div className="sidebar-head">
        <span className="brand">claude-cockpit</span>
        <div className="head-actions">
          {updateStaged && (
            <button
              className="update-pill"
              title="An update is ready — restart to apply it"
              onClick={onApplyUpdate}
            >
              ⟳ Restart to update
            </button>
          )}
          <button className="new-btn" title="Hide sidebar" onClick={onCollapse}>
            «
          </button>
          <button className="new-btn" title="Settings" onClick={onOpenSettings}>
            ⚙
          </button>
          <button className="new-btn" title="New workspace" onClick={onNewWorkspace}>
            +
          </button>
        </div>
      </div>

      <SystemStats />

      <div className="ws-scroll">
        {workspaces.map((ws) => {
          const items = sessions.filter((s) => s.workspaceId === ws.id)
          const isCollapsed = collapsed.has(ws.id)
          const canDragWs = ws.id !== COCKPIT_WORKSPACE_ID
          const wsDropTarget =
            drag?.kind === 'ws' && drag.id !== ws.id && canDragWs && dropId === ws.id
          return (
            <div
              className={`ws-group ${wsDropTarget ? 'drop-target' : ''} ${
                drag?.kind === 'ws' && drag.id === ws.id ? 'dragging' : ''
              }`}
              key={ws.id}
              onDragOver={(e) => {
                if (drag?.kind === 'ws' && drag.id !== ws.id && canDragWs) {
                  e.preventDefault()
                  setDropId(ws.id)
                }
              }}
              onDragLeave={() => setDropId((d) => (d === ws.id ? null : d))}
              onDrop={(e) => {
                if (drag?.kind === 'ws') {
                  e.preventDefault()
                  dropWorkspace(ws.id)
                }
                endDrag()
              }}
            >
              <div className="ws-header">
                {canDragWs && (
                  <span
                    className="drag-grip"
                    draggable
                    title="Drag to reorder"
                    onDragStart={(e) => {
                      setDrag({ kind: 'ws', id: ws.id })
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', ws.id)
                    }}
                    onDragEnd={endDrag}
                  >
                    ⠿
                  </span>
                )}
                <button className="ws-chevron" onClick={() => toggleCollapse(ws.id)}>
                  {isCollapsed ? '▸' : '▾'}
                </button>
                {editingWsId === ws.id ? (
                  <input
                    className="rename-input ws-name-input"
                    autoFocus
                    value={wsDraft}
                    onChange={(e) => setWsDraft(e.target.value)}
                    onBlur={commitWs}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitWs()
                      if (e.key === 'Escape') setEditingWsId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className={`ws-name ${ws.path ? 'link' : ''}`}
                    title={
                      ws.id === COCKPIT_WORKSPACE_ID
                        ? ws.path
                        : ws.path
                          ? `${ws.path} · click to open the repo · double-click to rename`
                          : 'No folder set — double-click to rename, or edit to choose one'
                    }
                    onClick={() => {
                      // Defer the open so a following double-click (rename) can cancel it.
                      if (!ws.path || nameClickTimer.current) return
                      const path = ws.path
                      nameClickTimer.current = setTimeout(() => {
                        nameClickTimer.current = null
                        openRepo(path)
                      }, 230)
                    }}
                    onDoubleClick={(e) => {
                      if (nameClickTimer.current) {
                        clearTimeout(nameClickTimer.current)
                        nameClickTimer.current = null
                      }
                      if (ws.id === COCKPIT_WORKSPACE_ID) return
                      e.stopPropagation()
                      startWsEdit(ws)
                    }}
                  >
                    {ws.name}
                  </span>
                )}
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
                        {ws.id !== COCKPIT_WORKSPACE_ID && (
                          <>
                            <button
                              onClick={() => {
                                setMenuFor(null)
                                startWsEdit(ws)
                              }}
                            >
                              Rename in Cockpit…
                            </button>
                            <button
                              onClick={() => {
                                setMenuFor(null)
                                onEditWorkspace(ws)
                              }}
                            >
                              Edit workspace…
                            </button>
                            {ws.path && (
                              <button
                                onClick={() => {
                                  setMenuFor(null)
                                  onNewIssue(ws)
                                }}
                              >
                                New GitHub issue…
                              </button>
                            )}
                            {ws.path && (
                              <button
                                onClick={() => {
                                  setMenuFor(null)
                                  onRenameRepo(ws)
                                }}
                              >
                                Rename GitHub repo…
                              </button>
                            )}
                            <button
                              className="danger"
                              onClick={() => {
                                setMenuFor(null)
                                onDeleteWorkspace(ws.id)
                              }}
                            >
                              Remove workspace
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
              {!isCollapsed && (
                <div
                  className="ws-path mono"
                  title={ws.path || 'No folder set — sessions start in your home directory'}
                >
                  {ws.path || 'No folder yet'}
                </div>
              )}
              {!isCollapsed && ws.path && <WorkspaceGit path={ws.path} />}
              {!isCollapsed && (
                <WorkspaceArchived
                  items={archived.filter((a) => a.workspaceId === ws.id)}
                  onRestore={onRestoreArchived}
                  onDelete={onDeleteArchived}
                />
              )}
              {!isCollapsed && ws.path && (
                <WorkspaceIssues
                  workspaceId={ws.id}
                  path={ws.path}
                  sessions={items}
                  onStart={onStartIssue}
                  refreshSignal={issuesRefreshKey}
                />
              )}
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

        {(ungrouped.length > 0 || archivedUngrouped.length > 0) && (
          <div className="ws-group">
            <div className="ws-header">
              <span className="ws-chevron-spacer" />
              <span className="ws-name muted">Other</span>
            </div>
            {ungrouped.length > 0 && (
              <ul className="session-list">{ungrouped.map(renderItem)}</ul>
            )}
            <WorkspaceArchived
              items={archivedUngrouped}
              onRestore={onRestoreArchived}
              onDelete={onDeleteArchived}
            />
          </div>
        )}
      </div>

      {ctxMenu && (
        <>
          <div className="menu-overlay" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }} />
          <div
            className="ctx-menu"
            style={{
              // Clamp to the viewport so a right-click near the bottom/right edge
              // isn't clipped (menu ~200×210 for the full set).
              left: Math.max(8, Math.min(ctxMenu.x, window.innerWidth - 208)),
              top: Math.max(8, Math.min(ctxMenu.y, window.innerHeight - 218))
            }}
          >
            <div className="ctx-menu-title">{ctxMenu.s.name}</div>
            {ctxMenu.s.kind !== 'dev' && (
              <button
                onClick={() => {
                  onRestart(ctxMenu.s.id)
                  setCtxMenu(null)
                }}
                title="Relaunch claude in place, resuming the conversation (e.g. to pick up a new model)"
              >
                ↻ Restart session
              </button>
            )}
            <button
              onClick={() => {
                startEdit(ctxMenu.s)
                setCtxMenu(null)
              }}
            >
              ✎ Rename
            </button>
            {ctxMenu.s.kind !== 'dev' && (
              <button
                onClick={() => {
                  onArchive(ctxMenu.s.id)
                  setCtxMenu(null)
                }}
              >
                📦 Archive
              </button>
            )}
            <button
              className="danger"
              onClick={() => {
                onClose(ctxMenu.s.id)
                setCtxMenu(null)
              }}
            >
              × Close session
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
