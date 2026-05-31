import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { SessionManager } from './sessions.js'
import { startIngestServer, type IngestServer } from './ingest.js'
import { initStore, getFlag, setFlag } from './store.js'
import { hookStatus, installHooks, uninstallHooks } from './hooks-install.js'
import type { HookEvent } from '../shared/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** Project root (out/main/index.js -> ../..). Also where the app's own repo lives in dev. */
const APP_ROOT = join(__dirname, '..', '..')
const ICON_PNG = join(APP_ROOT, 'build', 'icon.png')

let mainWindow: BrowserWindow | null = null
let manager: SessionManager
let ingest: IngestServer
/** Set true only on the launch where we auto-installed hooks (for the one-time notice). */
let hooksJustInstalled = false

/** Absolute path to the hook emitter script (dev: repo/hooks, prod: resources). */
function emitScriptPath(): string {
  // out/main/index.js -> ../../hooks/emit.mjs in dev; packaged apps should ship hooks/ alongside.
  return join(__dirname, '..', '..', 'hooks', 'emit.mjs')
}

/** True for MCP tools that drive a browser (claude-in-chrome and friends). */
function isBrowserTool(toolName: string): boolean {
  return /^mcp__/.test(toolName) && /(chrome|browser|playwright|puppeteer)/i.test(toolName)
}

/** A short label for a browser tool call, e.g. "navigate example.com", or null if not a browser tool. */
function browserToolTarget(e: HookEvent): string | null {
  const toolName = String(e.tool_name || '')
  if (!isBrowserTool(toolName)) return null
  const action = toolName.split('__').slice(2).join('__') || 'browser'
  const input = e.tool_input as { url?: string; href?: string } | undefined
  const url = input?.url || input?.href
  if (typeof url === 'string') {
    try {
      return `${action} ${new URL(url).host}`
    } catch {
      /* not a URL */
    }
  }
  return action
}

/** Map an incoming hook event to a status change on the right pane. */
function handleHookEvent(e: HookEvent): void {
  let paneId = e.cockpit_pane_id
  if (!paneId && e.session_id) paneId = manager.paneIdForClaudeSession(e.session_id)
  if (!paneId) return

  if (e.session_id) manager.bindClaudeSession(paneId, e.session_id)

  const name = e.hook_event_name
  const tool = (e.tool_name as string) || 'a tool'
  const browser = browserToolTarget(e)
  switch (name) {
    case 'SessionStart':
      return manager.setStatus(paneId, 'idle', 'session started')
    case 'UserPromptSubmit':
      return manager.setStatus(paneId, 'working', 'you sent a prompt')
    case 'PreToolUse':
      if (browser) manager.setUsingChrome(paneId, true, browser)
      return manager.setStatus(paneId, 'working', browser ? `🌐 ${browser}` : `running ${tool}`)
    case 'PostToolUse':
      return manager.setStatus(paneId, 'working', browser ? `🌐 ${browser}` : `ran ${tool}`)
    case 'SubagentStop':
      return manager.setStatus(paneId, 'working', 'a sub-agent finished')
    case 'Stop':
      manager.setUsingChrome(paneId, false)
      return manager.setStatus(paneId, 'idle', 'finished — ready')
    case 'SessionEnd':
      manager.setUsingChrome(paneId, false)
      return manager.setStatus(paneId, 'idle', 'session ended')
    case 'Notification': {
      const kind = String(e.notification_type || e.matcher || '').toLowerCase()
      if (kind.includes('permission')) return manager.setStatus(paneId, 'waiting', 'awaiting permission')
      if (kind.includes('elicit')) return manager.setStatus(paneId, 'waiting', 'needs your input')
      if (kind.includes('idle')) return manager.setStatus(paneId, 'idle', 'waiting for your input')
      return manager.setStatus(paneId, 'waiting', kind || 'needs attention')
    }
    default:
      return
  }
}

function broadcastSessions(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sessions:changed', manager.list())
  }
}

async function bootstrap(): Promise<void> {
  initStore()

  // Auto-install status hooks once, ever. If the user later removes them, we
  // won't reinstall (the flag stays set), so we never fight their choice.
  if (!getFlag('hooksAutoInstallTried')) {
    setFlag('hooksAutoInstallTried', true)
    try {
      if (!hookStatus(emitScriptPath()).installed) {
        installHooks(emitScriptPath())
        hooksJustInstalled = true
      }
    } catch {
      /* settings.json unwritable — fall back to the manual banner */
    }
  }

  ingest = await startIngestServer(handleHookEvent)
  manager = new SessionManager(ingest.port)

  manager.on('data', (paneId: string, chunk: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', paneId, chunk)
    }
  })
  manager.on('sessions', broadcastSessions)

  // ---- IPC ----
  ipcMain.handle('sessions:list', () => manager.list())
  ipcMain.handle('sessions:create', (_e, opts) => manager.create(opts))
  ipcMain.handle('sessions:close', (_e, id: string) => manager.close(id))
  ipcMain.handle('sessions:rename', (_e, id: string, name: string) => manager.rename(id, name))
  ipcMain.handle('pty:attach', (_e, id: string) => manager.getBuffer(id))
  ipcMain.on('pty:write', (_e, id: string, data: string) => manager.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )
  ipcMain.handle('hooks:status', () => hookStatus(emitScriptPath()))
  ipcMain.handle('hooks:install', () => installHooks(emitScriptPath()))
  ipcMain.handle('hooks:uninstall', () => uninstallHooks(emitScriptPath()))
  ipcMain.handle('sessions:create-dev', () => createDevSession())
  ipcMain.handle('app:info', () => appInfo())
  ipcMain.handle('app:relaunch', (_e, opts) => relaunchApp(opts))

  // Restore panes from the previous run (resumes Claude conversations where possible).
  manager.restore()
}

/** Info about the app's own repo + runtime. */
function appInfo(): {
  repoRoot: string
  devAvailable: boolean
  isDev: boolean
  hooksJustInstalled: boolean
} {
  const devAvailable =
    existsSync(join(APP_ROOT, 'package.json')) && existsSync(join(APP_ROOT, 'src'))
  return { repoRoot: APP_ROOT, devAvailable, isDev: !app.isPackaged, hooksJustInstalled }
}

/** The special "work on claude-cockpit itself" session, opened in the app's repo. */
function createDevSession(): ReturnType<SessionManager['create']> {
  return manager.create({
    cwd: APP_ROOT,
    command: 'claude',
    name: 'Cockpit Dev',
    kind: 'dev'
  })
}

function runBuild(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], { cwd: APP_ROOT, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`build exited ${code}`))
    )
  })
}

/** Persist + relaunch (packaged), optionally rebuilding first. Sessions are already persisted. */
async function relaunchApp(opts?: {
  rebuild?: boolean
}): Promise<{ ok: boolean; message?: string }> {
  if (app.isPackaged) {
    try {
      if (opts?.rebuild) await runBuild()
    } catch (e) {
      return { ok: false, message: `Build failed: ${(e as Error).message}` }
    }
    app.relaunch()
    app.exit(0)
    return { ok: true }
  }
  // Dev: electron-vite owns the process; a hard relaunch would kill the dev server.
  // Code edits already hot-restart the app, so we don't tear it down here.
  return {
    ok: false,
    message:
      'In dev (npm run dev) the app hot-reloads on code changes automatically. ' +
      'Self-relaunch is available in the packaged build.'
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#14161b',
    titleBarStyle: 'hiddenInset',
    icon: ICON_PNG,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Dock icon (macOS dev) — packaged builds get it from the bundle.
  if (process.platform === 'darwin' && app.dock) {
    const img = nativeImage.createFromPath(ICON_PNG)
    if (!img.isEmpty()) app.dock.setIcon(img)
  }
  await bootstrap()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  manager?.disposeAll()
  ingest?.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  manager?.disposeAll()
  ingest?.close()
})
