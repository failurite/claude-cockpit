import { contextBridge, ipcRenderer } from 'electron'
import type { CockpitApi, TerminalSession } from '../shared/types.js'

// Fan-out of broadcast IPC events to per-pane / global subscribers in the renderer.
const dataSubs = new Map<string, Set<(data: string) => void>>()
const sessionSubs = new Set<(s: TerminalSession[]) => void>()

ipcRenderer.on('pty:data', (_e, paneId: string, data: string) => {
  dataSubs.get(paneId)?.forEach((cb) => cb(data))
})
ipcRenderer.on('sessions:changed', (_e, sessions: TerminalSession[]) => {
  sessionSubs.forEach((cb) => cb(sessions))
})

const api: CockpitApi = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  createDevSession: () => ipcRenderer.invoke('sessions:create-dev'),
  closeSession: (id) => ipcRenderer.invoke('sessions:close', id),
  renameSession: (id, name) => ipcRenderer.invoke('sessions:rename', id, name),
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
  relaunchApp: (opts) => ipcRenderer.invoke('app:relaunch', opts),
  tmux: {
    available: () => ipcRenderer.invoke('tmux:available'),
    list: () => ipcRenderer.invoke('tmux:list'),
    kill: (name) => ipcRenderer.invoke('tmux:kill', name)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch)
  }
}

contextBridge.exposeInMainWorld('cockpit', api)
