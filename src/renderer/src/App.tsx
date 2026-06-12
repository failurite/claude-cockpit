import { useCallback, useEffect, useState } from 'react'
import type {
  AppInfo,
  ArchivedSessionInfo,
  HookInstallState,
  TerminalSession,
  Workspace
} from '../../shared/types'
import { DEFAULT_SESSION_OPTIONS } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'
import { BrowserPanel } from './components/BrowserPanel'
import { LaunchDialog, type LaunchValues } from './components/LaunchDialog'
import { SettingsPanel } from './components/SettingsPanel'

/** Which modal (if any) is open, and the context it needs. */
type Dialog =
  | { kind: 'workspace-new' }
  | { kind: 'workspace-edit'; ws: Workspace }
  | { kind: 'session-custom'; workspaceId: string }

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hooks, setHooks] = useState<HookInstallState | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Archived (closed-but-saved) sessions, reopenable on demand.
  const [archived, setArchived] = useState<ArchivedSessionInfo[]>([])
  // Which panes currently show their embedded browser (auto-opens on first tab).
  const [browserOpen, setBrowserOpen] = useState<Record<string, boolean>>({})

  // Sidebar width + collapsed state, persisted across launches.
  const [sbWidth, setSbWidth] = useState(() => {
    const w = Number(localStorage.getItem('sidebarWidth'))
    return w >= 180 && w <= 520 ? w : 248
  })
  const [sbCollapsed, setSbCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === '1'
  )
  useEffect(() => localStorage.setItem('sidebarWidth', String(sbWidth)), [sbWidth])
  useEffect(
    () => localStorage.setItem('sidebarCollapsed', sbCollapsed ? '1' : '0'),
    [sbCollapsed]
  )
  const startSidebarDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = sbWidth
      const move = (ev: MouseEvent): void =>
        setSbWidth(Math.min(520, Math.max(180, startW + ev.clientX - startX)))
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.classList.remove('dragging-h')
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      document.body.classList.add('dragging-h')
    },
    [sbWidth]
  )

  // Initial load + live updates.
  useEffect(() => {
    window.cockpit.listSessions().then((s) => {
      setSessions(s)
      if (s.length && !activeId) setActiveId(s[0].id)
    })
    window.cockpit.workspaces.list().then(setWorkspaces)
    window.cockpit.archivedSessions().then(setArchived)
    const off = window.cockpit.onSessionsChanged(setSessions)
    window.cockpit.hooks.status().then(setHooks)
    window.cockpit.appInfo().then((info) => {
      setAppInfo(info)
      // Surface the one-time auto-install in Settings rather than a banner.
      if (info.hooksJustInstalled) setSettingsOpen(true)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep an active selection valid as sessions come and go.
  useEffect(() => {
    if (!sessions.find((s) => s.id === activeId)) {
      setActiveId(sessions[0]?.id ?? null)
    }
  }, [sessions, activeId])

  // Auto-reveal a pane's browser the moment the agent opens its first tab.
  useEffect(() => {
    const off = window.cockpit.browser.onTabsChanged((paneId, tabs) => {
      if (tabs.length > 0) setBrowserOpen((m) => (m[paneId] ? m : { ...m, [paneId]: true }))
    })
    return off
  }, [])

  const newSession = useCallback(async (workspaceId: string) => {
    const s = await window.cockpit.createSession({ workspaceId })
    setActiveId(s.id)
  }, [])

  const closeSession = useCallback((id: string) => window.cockpit.closeSession(id), [])

  // Archive (close & save) / reopen / forget. Each refreshes the archived list.
  const archiveSession = useCallback(async (id: string) => {
    setArchived(await window.cockpit.archiveSession(id))
  }, [])
  const restoreArchived = useCallback(async (archivedId: string) => {
    const s = await window.cockpit.restoreArchivedSession(archivedId)
    if (s) setActiveId(s.id)
    setArchived(await window.cockpit.archivedSessions())
  }, [])
  const deleteArchived = useCallback(async (archivedId: string) => {
    setArchived(await window.cockpit.deleteArchivedSession(archivedId))
  }, [])

  // GitHub-issue sessions: start (or focus) one, and the Done merge flow.
  const [issueBusy, setIssueBusy] = useState(false)
  const [issueMsg, setIssueMsg] = useState<string | null>(null)
  // Bumped after a successful Done so the workspace Issues lists re-fetch (the
  // just-merged issue is now closed and should drop off the open-issues list).
  const [issuesRefreshKey, setIssuesRefreshKey] = useState(0)
  const startIssue = useCallback(async (workspaceId: string, number: number) => {
    try {
      const s = await window.cockpit.issues.start(workspaceId, number)
      setActiveId(s.id)
    } catch (e) {
      setIssueMsg(`Couldn't start issue session: ${(e as Error).message}`)
    }
  }, [])
  const doneIssue = useCallback(async (paneId: string) => {
    setIssueBusy(true)
    setIssueMsg(null)
    const r = await window.cockpit.issues.done(paneId)
    setIssueMsg(r.message)
    // Merged → the issue is closed on GitHub; refresh the Issues lists to drop it.
    if (r.ok) setIssuesRefreshKey((k) => k + 1)
    setIssueBusy(false)
  }, [])
  const renameSession = useCallback(
    (id: string, name: string) => window.cockpit.renameSession(id, name),
    []
  )

  const installHooks = useCallback(async () => {
    setHooks(await window.cockpit.hooks.install())
  }, [])
  const uninstallHooks = useCallback(async () => {
    setHooks(await window.cockpit.hooks.uninstall())
  }, [])

  // Returns an error/status message to show, or null on success.
  const relaunch = useCallback(async (rebuild: boolean): Promise<string | null> => {
    const res = await window.cockpit.relaunchApp({ rebuild })
    return res.ok ? null : res.message ?? 'Relaunch unavailable.'
  }, [])

  const deleteWorkspace = useCallback(async (id: string) => {
    setWorkspaces(await window.cockpit.workspaces.remove(id))
  }, [])

  // --- dialog submit handlers ---
  const submitDialog = useCallback(
    async (v: LaunchValues) => {
      if (!dialog) return
      if (dialog.kind === 'workspace-new') {
        const ws: Workspace = {
          id: crypto.randomUUID(),
          name: v.name || v.path.split('/').filter(Boolean).pop() || v.path,
          path: v.path,
          defaults: v.options
        }
        setWorkspaces(await window.cockpit.workspaces.save(ws))
        const s = await window.cockpit.createSession({ workspaceId: ws.id })
        setActiveId(s.id)
      } else if (dialog.kind === 'workspace-edit') {
        const ws: Workspace = { ...dialog.ws, name: v.name || dialog.ws.name, defaults: v.options }
        setWorkspaces(await window.cockpit.workspaces.save(ws))
      } else if (dialog.kind === 'session-custom') {
        const s = await window.cockpit.createSession({
          workspaceId: dialog.workspaceId,
          name: v.name || undefined,
          options: v.options
        })
        setActiveId(s.id)
      }
      setDialog(null)
    },
    [dialog]
  )

  const active = sessions.find((s) => s.id === activeId) ?? null

  // Resolve initial values for whichever dialog is open.
  const dialogProps = ((): { mode: 'workspace' | 'session'; title: string; submit: string; initial: LaunchValues } | null => {
    if (!dialog) return null
    if (dialog.kind === 'workspace-new')
      return {
        mode: 'workspace',
        title: 'New workspace',
        submit: 'Create workspace',
        initial: { name: '', path: '', options: { ...DEFAULT_SESSION_OPTIONS } }
      }
    if (dialog.kind === 'workspace-edit')
      return {
        mode: 'workspace',
        title: 'Edit workspace',
        submit: 'Save',
        initial: { name: dialog.ws.name, path: dialog.ws.path, options: { ...dialog.ws.defaults } }
      }
    const ws = workspaces.find((w) => w.id === dialog.workspaceId)
    return {
      mode: 'session',
      title: 'New session — custom settings',
      submit: 'Create session',
      initial: { name: '', path: ws?.path ?? '', options: { ...(ws?.defaults ?? DEFAULT_SESSION_OPTIONS) } }
    }
  })()

  return (
    <div className="app">
      {sbCollapsed ? (
        <div className="sidebar-rail">
          <button className="new-btn" title="Show sidebar" onClick={() => setSbCollapsed(false)}>
            »
          </button>
        </div>
      ) : (
        <>
          <Sidebar
            sessions={sessions}
            workspaces={workspaces}
            activeId={activeId}
            onSelect={setActiveId}
            onClose={closeSession}
            onArchive={archiveSession}
            archived={archived}
            onRestoreArchived={restoreArchived}
            onDeleteArchived={deleteArchived}
            onRename={renameSession}
            onNewSession={newSession}
            onCustomSession={(workspaceId) => setDialog({ kind: 'session-custom', workspaceId })}
            onNewWorkspace={() => setDialog({ kind: 'workspace-new' })}
            onEditWorkspace={(ws) => setDialog({ kind: 'workspace-edit', ws })}
            onDeleteWorkspace={deleteWorkspace}
            onStartIssue={startIssue}
            issuesRefreshKey={issuesRefreshKey}
            onOpenSettings={() => setSettingsOpen(true)}
            width={sbWidth}
            onCollapse={() => setSbCollapsed(true)}
          />
          <div className="v-resizer" onMouseDown={startSidebarDrag} title="Drag to resize" />
        </>
      )}
      <main className="stage">
        <div className="work">
          <div className="terminals">
            {sessions.length === 0 && (
              <div className="empty">
                <h1>claude-cockpit</h1>
                <p>No sessions yet. Create a workspace to get started.</p>
                <div className="empty-actions">
                  <button onClick={() => setDialog({ kind: 'workspace-new' })}>+ New workspace</button>
                </div>
              </div>
            )}
            {sessions.map((s) => (
              <TerminalView key={s.id} session={s} active={s.id === activeId} />
            ))}
          </div>
          {active && browserOpen[active.id] && (
            <BrowserPanel
              key={active.id}
              paneId={active.id}
              onClose={() => setBrowserOpen((m) => ({ ...m, [active.id]: false }))}
            />
          )}
        </div>
        {active && (
          <footer className="statusbar">
            <span className={`dot ${active.status}`} />
            <strong>{active.name}</strong>
            {active.kind === 'dev' && <span className="dev-tag">DEV</span>}
            <button
              className="browser-toggle"
              onClick={() => setBrowserOpen((m) => ({ ...m, [active.id]: !m[active.id] }))}
              title={browserOpen[active.id] ? 'Hide browser' : 'Show browser'}
            >
              🌐 {browserOpen[active.id] ? 'Hide' : 'Browser'}
            </button>
            {active.issue && (
              <button
                className="done-btn"
                disabled={issueBusy}
                onClick={() => doneIssue(active.id)}
                title={`Rebase, merge to the default branch, push, and close issue #${active.issue.number}`}
              >
                {issueBusy ? 'Merging…' : `✓ Done #${active.issue.number}`}
              </button>
            )}
            {issueMsg && (
              <span className="muted issue-msg" title={issueMsg}>
                {issueMsg.split('\n')[0]}
              </span>
            )}
            <span className="muted">{active.status}</span>
            <span className="muted">· {active.lastActivity}</span>
            {active.usingChrome && (
              <span className="chrome-badge" title={active.chromeActivity ?? 'driving Chrome'}>
                🌐 Chrome{active.chromeActivity ? ` · ${active.chromeActivity}` : ''}
              </span>
            )}
            {active.subagentCount > 0 && (
              <span className="subagents">⛓ {active.subagentCount} sub-agents</span>
            )}
            <span className="spacer" />
            <span className="muted mono">{active.cwd}</span>
          </footer>
        )}
      </main>

      {dialogProps && (
        <LaunchDialog
          mode={dialogProps.mode}
          title={dialogProps.title}
          submitLabel={dialogProps.submit}
          initial={dialogProps.initial}
          onSubmit={submitDialog}
          onCancel={() => setDialog(null)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          hooks={hooks}
          appInfo={appInfo}
          onInstallHooks={installHooks}
          onUninstallHooks={uninstallHooks}
          onRelaunch={relaunch}
          onRefreshWorkspaces={() => window.cockpit.workspaces.list().then(setWorkspaces)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
