import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserTab, CockpitApi, TerminalSession, UpdateStatus } from '../shared/types.js'

// Fan-out of broadcast IPC events to per-pane / global subscribers in the renderer.
const dataSubs = new Map<string, Set<(data: string) => void>>()
const sessionSubs = new Set<(s: TerminalSession[]) => void>()
const updateSubs = new Set<(s: UpdateStatus) => void>()
const browserTabSubs = new Set<(paneId: string, tabs: BrowserTab[]) => void>()
const refocusSubs = new Set<() => void>()

ipcRenderer.on('pty:data', (_e, paneId: string, data: string) => {
  dataSubs.get(paneId)?.forEach((cb) => cb(data))
})
ipcRenderer.on('sessions:changed', (_e, sessions: TerminalSession[]) => {
  sessionSubs.forEach((cb) => cb(sessions))
})
ipcRenderer.on('updates:status', (_e, s: UpdateStatus) => {
  updateSubs.forEach((cb) => cb(s))
})
ipcRenderer.on('browser:tabs', (_e, paneId: string, tabs: BrowserTab[]) => {
  browserTabSubs.forEach((cb) => cb(paneId, tabs))
})
ipcRenderer.on('terminal:refocus', () => {
  refocusSubs.forEach((cb) => cb())
})

const api: CockpitApi = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  createDevSession: () => ipcRenderer.invoke('sessions:create-dev'),
  closeSession: (id) => ipcRenderer.invoke('sessions:close', id),
  closeAllSessions: () => ipcRenderer.invoke('sessions:close-all'),
  renameSession: (id, name) => ipcRenderer.invoke('sessions:rename', id, name),
  archiveSession: (id) => ipcRenderer.invoke('sessions:archive', id),
  archivedSessions: () => ipcRenderer.invoke('sessions:archived-list'),
  restoreArchivedSession: (archivedId) => ipcRenderer.invoke('sessions:restore-archived', archivedId),
  deleteArchivedSession: (archivedId) => ipcRenderer.invoke('sessions:delete-archived', archivedId),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  attach: (id) => ipcRenderer.invoke('pty:attach', id),
  onData: (id, cb) => {
    let set = dataSubs.get(id)
    if (!set) dataSubs.set(id, (set = new Set()))
    set.add(cb)
    return () => set!.delete(cb)
  },
  onSessionsChanged: (cb) => {
    sessionSubs.add(cb)
    return () => sessionSubs.delete(cb)
  },
  onRefocusTerminal: (cb) => {
    refocusSubs.add(cb)
    return () => refocusSubs.delete(cb)
  },
  hooks: {
    status: () => ipcRenderer.invoke('hooks:status'),
    install: () => ipcRenderer.invoke('hooks:install'),
    uninstall: () => ipcRenderer.invoke('hooks:uninstall')
  },
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    save: (ws) => ipcRenderer.invoke('workspaces:save', ws),
    remove: (id) => ipcRenderer.invoke('workspaces:remove', id)
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  relaunchApp: (opts) => ipcRenderer.invoke('app:relaunch', opts),
  tmux: {
    available: () => ipcRenderer.invoke('tmux:available'),
    list: () => ipcRenderer.invoke('tmux:list'),
    kill: (name) => ipcRenderer.invoke('tmux:kill', name)
  },
  browser: {
    listTabs: (paneId) => ipcRenderer.invoke('browser:list', paneId),
    openTab: (paneId, url) => ipcRenderer.invoke('browser:open', paneId, url),
    closeTab: (paneId, tabId) => ipcRenderer.invoke('browser:close', paneId, tabId),
    activateTab: (paneId, tabId) => ipcRenderer.invoke('browser:activate', paneId, tabId),
    navigate: (paneId, tabId, url) => ipcRenderer.invoke('browser:navigate', paneId, tabId, url),
    setBounds: (paneId, bounds) => ipcRenderer.send('browser:set-bounds', paneId, bounds),
    setVisible: (paneId, visible) => ipcRenderer.send('browser:set-visible', paneId, visible),
    setOverlaySuppressed: (suppressed) =>
      ipcRenderer.send('browser:suppress-overlay', suppressed),
    onTabsChanged: (cb) => {
      browserTabSubs.add(cb)
      return () => browserTabSubs.delete(cb)
    }
  },
  issues: {
    available: (dir) => ipcRenderer.invoke('issues:available', dir),
    list: (dir) => ipcRenderer.invoke('issues:list', dir),
    view: (dir, number) => ipcRenderer.invoke('issues:view', dir, number),
    start: (workspaceId, number) => ipcRenderer.invoke('issues:start', workspaceId, number),
    done: (paneId) => ipcRenderer.invoke('issues:done', paneId)
  },
  git: {
    status: (dir, fetch) => ipcRenderer.invoke('git:status', dir, fetch),
    push: (dir) => ipcRenderer.invoke('git:push', dir),
    pull: (dir) => ipcRenderer.invoke('git:pull', dir)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch)
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    onStatus: (cb) => {
      updateSubs.add(cb)
      return () => updateSubs.delete(cb)
    }
  }
}

contextBridge.exposeInMainWorld('cockpit', api)
