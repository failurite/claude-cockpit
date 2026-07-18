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
import { RepoRenameDialog } from './components/RepoRenameDialog'
import { SettingsPanel } from './components/SettingsPanel'

/** Short, footer-friendly model label: `claude-opus-4-8[1m]` → `opus-4-8[1m]`; null → `…`. */
function shortModel(model: string | null): string {
  if (!model) return '…'
  return model.replace(/^claude-/, '')
}

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
  // Workspace whose GitHub repo is being renamed (null = dialog closed).
  const [renameRepoWs, setRenameRepoWs] = useState<Workspace | null>(null)
  // Archived (closed-but-saved) sessions, reopenable on demand.
  const [archived, setArchived] = useState<ArchivedSessionInfo[]>([])
  // Which panes currently show their embedded browser (auto-opens on first tab).
  const [browserOpen, setBrowserOpen] = useState<Record<string, boolean>>({})
  // Bumped when main asks us to re-focus the terminal (agent browser activity
  // stole OS focus); the active TerminalView re-focuses when it changes.
  const [refocusTick, setRefocusTick] = useState(0)
  // A locally-built update (`npm run update-app`) is staged on disk. `staged`
  // drives the persistent restart button; `prompt` is the one-time now/later ask.
  const [updateStaged, setUpdateStaged] = useState(false)
  const [updatePrompt, setUpdatePrompt] = useState(false)

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
    // Re-focus the terminal after agent browser activity, unless the user is in
    // an app text field (URL bar / rename are <input>; xterm uses <textarea>).
    const offRefocus = window.cockpit.onRefocusTerminal(() => {
      if (document.activeElement?.tagName === 'INPUT') return
      setRefocusTick((n) => n + 1)
    })
    window.cockpit.hooks.status().then(setHooks)
    window.cockpit.appInfo().then((info) => {
      setAppInfo(info)
      // Surface the one-time auto-install in Settings rather than a banner.
      if (info.hooksJustInstalled) setSettingsOpen(true)
    })
    return () => {
      off()
      offRefocus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep an active selection valid as sessions come and go.
  useEffect(() => {
    if (!sessions.find((s) => s.id === activeId)) {
      setActiveId(sessions[0]?.id ?? null)
    }
  }, [sessions, activeId])

  // A staged local update: prompt now/later when it lands, and keep a restart
  // button afterward. Also re-check on mount in case the event fired first.
  useEffect(() => {
    const off = window.cockpit.updates.onStaged(() => {
      setUpdateStaged(true)
      setUpdatePrompt(true)
    })
    window.cockpit.updates.stagedPending().then((p) => p && setUpdateStaged(true))
    return off
  }, [])
  const applyUpdate = useCallback(() => window.cockpit.updates.applyStaged(), [])

  // An app-level modal (workspace/session dialog or Settings) must sit above
  // everything — but the embedded browser is a native overlay that always paints
  // over renderer HTML. Force it hidden while any modal is open.
  useEffect(() => {
    window.cockpit.browser.setOverlaySuppressed(
      !!dialog || settingsOpen || updatePrompt || !!renameRepoWs
    )
  }, [dialog, settingsOpen, updatePrompt, renameRepoWs])

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
  const restartSession = useCallback(async (id: string) => {
    const s = await window.cockpit.restartSession(id)
    if (s) setActiveId(s.id)
  }, [])

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

  // Inline rename (double-click the workspace name) — saves the workspace with a
  // new name, leaving its folder + defaults untouched.
  const renameWorkspace = useCallback(
    async (id: string, name: string) => {
      const ws = workspaces.find((w) => w.id === id)
      if (!ws || !name.trim() || name.trim() === ws.name) return
      setWorkspaces(await window.cockpit.workspaces.save({ ...ws, name: name.trim() }))
    },
    [workspaces]
  )

  // --- dialog submit handlers ---
  // Resolves with an error string to keep the dialog open (e.g. a clone failed),
  // or null on success (the dialog then closes).
  const submitDialog = useCallback(
    async (v: LaunchValues): Promise<string | null> => {
      if (!dialog) return null
      if (dialog.kind === 'workspace-new') {
        if (v.source === 'new' && v.newRepo) {
          // Create a brand-new GitHub repo, clone it, and point the workspace at it.
          const res = await window.cockpit.workspaces.createRepo({
            name: v.newRepo.name,
            private: v.newRepo.private,
            parentDir: v.path || undefined,
            description: v.newRepo.description || undefined,
            workspaceName: v.name || undefined,
            defaults: v.options
          })
          if (!res.ok) return res.message ?? 'Repo creation failed.'
          setWorkspaces(res.workspaces)
          if (res.workspace) {
            const s = await window.cockpit.createSession({ workspaceId: res.workspace.id })
            setActiveId(s.id)
          }
          setDialog(null)
          return null
        }
        if (v.repoUrl) {
          // Clone a GitHub repo and point the new workspace at the checkout.
          const res = await window.cockpit.workspaces.createFromRepo({
            url: v.repoUrl,
            dir: v.path || undefined,
            name: v.name || undefined,
            defaults: v.options
          })
          if (!res.ok) return res.message ?? 'Clone failed.'
          setWorkspaces(res.workspaces)
          if (res.workspace) {
            const s = await window.cockpit.createSession({ workspaceId: res.workspace.id })
            setActiveId(s.id)
          }
          setDialog(null)
          return null
        }
        // Derive a name from the folder when none was typed; '~' (the default
        // root) reads as "Home" rather than a literal tilde.
        const base = v.path === '~' ? 'Home' : v.path.split('/').filter(Boolean).pop()
        const ws: Workspace = {
          id: crypto.randomUUID(),
          name: v.name || base || v.path || 'Workspace',
          path: v.path,
          defaults: v.options
        }
        setWorkspaces(await window.cockpit.workspaces.save(ws))
        const s = await window.cockpit.createSession({ workspaceId: ws.id })
        setActiveId(s.id)
      } else if (dialog.kind === 'workspace-edit') {
        const ws: Workspace = {
          ...dialog.ws,
          name: v.name || dialog.ws.name,
          path: v.path,
          defaults: v.options
        }
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
      return null
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
        initial: { name: '', path: '~', options: { ...DEFAULT_SESSION_OPTIONS } }
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
          {updateStaged && (
            <button
              className="update-pill rail"
              title="An update is ready — restart to apply it"
              onClick={applyUpdate}
            >
              ⟳
            </button>
          )}
        </div>
      ) : (
        <>
          <Sidebar
            sessions={sessions}
            workspaces={workspaces}
            activeId={activeId}
            onSelect={setActiveId}
            onClose={closeSession}
            onRestart={restartSession}
            onArchive={archiveSession}
            archived={archived}
            onRestoreArchived={restoreArchived}
            onDeleteArchived={deleteArchived}
            onRename={renameSession}
            onNewSession={newSession}
            onCustomSession={(workspaceId) => setDialog({ kind: 'session-custom', workspaceId })}
            onNewWorkspace={() => setDialog({ kind: 'workspace-new' })}
            onEditWorkspace={(ws) => setDialog({ kind: 'workspace-edit', ws })}
            onRenameWorkspace={renameWorkspace}
            onRenameRepo={(ws) => setRenameRepoWs(ws)}
            onDeleteWorkspace={deleteWorkspace}
            onStartIssue={startIssue}
            issuesRefreshKey={issuesRefreshKey}
            onOpenSettings={() => setSettingsOpen(true)}
            updateStaged={updateStaged}
            onApplyUpdate={applyUpdate}
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
              <TerminalView
                key={s.id}
                session={s}
                active={s.id === activeId}
                refocusSignal={refocusTick}
              />
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
            {active.tokensTotal > 0 && (
              <span className="muted" title="Tokens used this conversation (input + output + cache-creation)">
                ◇ {active.tokensTotal >= 1000 ? `${(active.tokensTotal / 1000).toFixed(1)}k` : active.tokensTotal} tok
              </span>
            )}
            {active.command === 'claude' && (
              <span
                className="model-box"
                title={
                  active.model
                    ? `Model in use: ${active.model} — pick another to switch (runs /model)`
                    : 'Model not detected yet — pick one to set it (runs /model)'
                }
              >
                <span className="model-name mono">◆ {shortModel(active.model)}</span>
                <select
                  className="model-select"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) window.cockpit.setSessionModel(active.id, e.target.value)
                    e.currentTarget.value = ''
                  }}
                >
                  <option value="" disabled>
                    change…
                  </option>
                  <option value="default">Default</option>
                  <option value="opus">Opus</option>
                  <option value="sonnet">Sonnet</option>
                  <option value="haiku">Haiku</option>
                  <option value="opus[1m]">Opus (1M)</option>
                  <option value="sonnet[1m]">Sonnet (1M)</option>
                </select>
              </span>
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
          allowGithubSource={dialog?.kind === 'workspace-new'}
          onSubmit={submitDialog}
          onCancel={() => setDialog(null)}
        />
      )}
      {renameRepoWs && (
        <RepoRenameDialog
          ws={renameRepoWs}
          onDone={async (newName) => {
            const ws = renameRepoWs
            setRenameRepoWs(null)
            // Follow the new repo name in the sidebar — but only if the label was
            // the default one derived from the old repo/folder name; keep a name
            // the user customised. Either way, re-read git so origin refreshes.
            const oldBase = ws.path.split('/').filter(Boolean).pop() || ''
            if (ws.name === oldBase && newName !== ws.name) {
              setWorkspaces(await window.cockpit.workspaces.save({ ...ws, name: newName }))
            } else {
              window.cockpit.workspaces.list().then(setWorkspaces)
            }
          }}
          onCancel={() => setRenameRepoWs(null)}
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
      {updatePrompt && (
        <div className="modal-backdrop" onClick={() => setUpdatePrompt(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">Update ready</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              A new build of Cockpit has been installed. Restart now to use it, or keep
              working — the <strong>⟳ Restart to update</strong> button stays in the sidebar
              until you do. Your sessions are restored on relaunch.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setUpdatePrompt(false)}>
                Later
              </button>
              <button className="btn primary" onClick={applyUpdate}>
                Restart now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
