import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/types.js'

// electron-updater ships as CommonJS; pull autoUpdater off the default export so
// this stays compatible with the ESM build output.
const { autoUpdater } = electronUpdater

/** Latest status, kept so the renderer can ask for it without forcing a check. */
let status: UpdateStatus = { state: 'idle', version: null, percent: null, message: null }

/** How the renderer gets the live main window (it can be recreated on macOS). */
type WindowGetter = () => BrowserWindow | null

function broadcast(getWindow: WindowGetter, next: Partial<UpdateStatus>): void {
  status = { ...status, ...next }
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('updates:status', status)
}

/**
 * Wire up auto-update. Only does real work in a packaged build — under `npm run
 * dev` (and for unsigned/ad-hoc apps, where Squirrel.Mac refuses to apply
 * updates) we report `unsupported` so the UI can explain instead of erroring.
 */
export function initUpdater(getWindow: WindowGetter): void {
  const set = (next: Partial<UpdateStatus>): void => broadcast(getWindow, next)

  ipcMain.handle('updates:status', () => status)
  ipcMain.handle('updates:install', () => {
    if (status.state === 'downloaded') autoUpdater.quitAndInstall()
  })
  ipcMain.handle('updates:check', async (): Promise<UpdateStatus> => {
    if (!app.isPackaged) return status
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      set({ state: 'error', message: (e as Error).message })
    }
    return status
  })

  if (!app.isPackaged) {
    status = {
      state: 'unsupported',
      version: app.getVersion(),
      percent: null,
      message: 'Auto-update runs only in the packaged, signed build.'
    }
    return
  }

  // Download in the background; install on the next quit unless the user restarts now.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => set({ state: 'checking', message: null }))
  autoUpdater.on('update-available', (info) =>
    set({ state: 'available', version: info.version, message: null })
  )
  autoUpdater.on('update-not-available', (info) =>
    set({ state: 'not-available', version: info.version, percent: null, message: null })
  )
  autoUpdater.on('download-progress', (p) =>
    set({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    set({ state: 'downloaded', version: info.version, percent: 100, message: null })
  )
  autoUpdater.on('error', (e) => set({ state: 'error', message: e.message }))

  // No launch-time check: updates are delivered locally via `npm run update-app`
  // (rebuild + swap the installed app), not from a GitHub Releases feed. The
  // "Check for updates" button still works if a feed is ever configured.
}
