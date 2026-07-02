import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { SessionManager, expandTilde } from './sessions.js'
import { startIngestServer, type IngestServer } from './ingest.js'
import { BrowserManager } from './browser.js'
import { startBrowserRpc, type BrowserRpcServer } from './browser-rpc.js'
import { startSessionsRpc, type SessionsRpcServer } from './sessions-rpc.js'
import { gitStatus, gitPush, gitPull } from './git.js'
import { ghAvailable, listIssues, viewIssue, closeIssue } from './issues.js'
import { createIssueWorktree, finishIssueWorktree } from './worktrees.js'
import type { IssueDoneResult, IssueRef } from '../shared/types.js'
import { initStore, getFlag, setFlag, getWorkspaces, saveWorkspaces } from './store.js'
import { hookStatus, installHooks, uninstallHooks } from './hooks-install.js'
import { initUpdater } from './updater.js'
import {
  isTmuxAvailable,
  listCockpitSessions,
  killCockpitSession,
  killAllCockpitSessions
} from './tmux.js'
import { IS_MAC, NPM_BIN } from './platform.js'
import type { HookEvent, Workspace, AppSettings } from '../shared/types.js'
import { COCKPIT_WORKSPACE_ID } from '../shared/types.js'

/** Fixed ingest port so a persistent tmux dev session can reach us after restarts. */
const INGEST_PORT = 47615
/** Fixed browser-RPC port so a session's frozen MCP env keeps reaching us after restarts. */
const BROWSER_RPC_PORT = 47616
/** Fixed sessions-RPC port (cross-session visibility); same frozen-env rationale. */
const SESSIONS_RPC_PORT = 47617

const __dirname = dirname(fileURLToPath(import.meta.url))
/** Project root (out/main/index.js -> ../..). In dev this is the repo; packaged it's the bundle. */
const APP_ROOT = join(__dirname, '..', '..')
const ICON_PNG = join(APP_ROOT, 'build', 'icon.png')

/**
 * The source checkout to edit/build from. Baked in at build time (`__REPO_ROOT__`)
 * so the packaged Desktop app still opens its dev session in the real repo — and
 * `npm run update-app` can rebuild from there. Falls back to APP_ROOT if the baked
 * path no longer exists (e.g. the repo was moved/deleted after building).
 */
const REPO_ROOT = existsSync(join(__REPO_ROOT__, 'package.json')) ? __REPO_ROOT__ : APP_ROOT

let mainWindow: BrowserWindow | null = null
let manager: SessionManager
let ingest: IngestServer
let browserMgr: BrowserManager
let browserRpc: BrowserRpcServer
let sessionsRpc: SessionsRpcServer
/** Set true only on the launch where we auto-installed hooks (for the one-time notice). */
let hooksJustInstalled = false

/** Absolute path to the hook emitter script (dev: repo/hooks, prod: resources). */
function emitScriptPath(): string {
  // Packaged: hooks/ is shipped as an extraResource next to the asar, so Claude
  // (an external process) can run emit.mjs — it can't execute from inside app.asar.
  if (app.isPackaged) return join(process.resourcesPath, 'hooks', 'emit.mjs')
  // Dev: out/main/index.js -> ../../hooks/emit.mjs in the repo.
  return join(__dirname, '..', '..', 'hooks', 'emit.mjs')
}

/** Absolute path to the embedded-browser MCP shim (dev: repo/mcp, prod: resources). */
function browserMcpScriptPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'mcp', 'cockpit-browser.mjs')
  return join(__dirname, '..', '..', 'mcp', 'cockpit-browser.mjs')
}

/**
 * Write (once per launch) the `--mcp-config` file that registers the
 * cockpit-browser MCP server for normal sessions, and return its path. The shim
 * learns its pane id + RPC port from inherited pty env, so this config is shared.
 */
function writeBrowserMcpConfig(): string {
  const cfg = {
    mcpServers: {
      'cockpit-browser': { command: 'node', args: [browserMcpScriptPath()] }
    }
  }
  const path = join(app.getPath('userData'), 'cockpit-browser.mcp.json')
  writeFileSync(path, JSON.stringify(cfg, null, 2))
  return path
}

/** Absolute path to the cross-session MCP shim (dev: repo/mcp, prod: resources). */
function sessionsMcpScriptPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'mcp', 'cockpit-sessions.mjs')
  return join(__dirname, '..', '..', 'mcp', 'cockpit-sessions.mjs')
}

/**
 * Write (once per launch) the `--mcp-config` file registering the cockpit-sessions
 * MCP server, handed to every normal session so it can see/read its siblings. The
 * shim learns its pane id + RPC port from inherited pty env, so this config is shared.
 */
function writeSessionsMcpConfig(): string {
  const cfg = {
    mcpServers: {
      'cockpit-sessions': { command: 'node', args: [sessionsMcpScriptPath()] }
    }
  }
  const path = join(app.getPath('userData'), 'cockpit-sessions.mcp.json')
  writeFileSync(path, JSON.stringify(cfg, null, 2))
  return path
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

  ingest = await startIngestServer(handleHookEvent, INGEST_PORT)

  // Embedded per-session browser: RPC endpoint the MCP shim calls, the manager
  // that owns the WebContentsViews, and the shared --mcp-config we hand sessions.
  browserMgr = new BrowserManager()
  browserRpc = await startBrowserRpc(browserMgr, BROWSER_RPC_PORT)
  const browserMcpConfig = writeBrowserMcpConfig()

  // Cross-session visibility: an RPC the cockpit-sessions shim calls to list/read
  // siblings. Started before the manager exists, so it reads the list lazily.
  sessionsRpc = await startSessionsRpc(() => manager?.list() ?? [], SESSIONS_RPC_PORT)
  const sessionsMcpConfig = writeSessionsMcpConfig()

  manager = new SessionManager(
    ingest.port,
    {
      mcpConfig: browserMcpConfig,
      port: browserRpc.port,
      getTabs: (paneId) => browserMgr.listTabs(paneId).map((t) => ({ url: t.url, active: t.active })),
      restoreTabs: (paneId, tabs) => void browserMgr.restoreTabs(paneId, tabs)
    },
    { mcpConfig: sessionsMcpConfig, port: sessionsRpc.port }
  )

  manager.on('data', (paneId: string, chunk: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', paneId, chunk)
    }
  })
  manager.on('sessions', broadcastSessions)
  // A restarted pane keeps its id but its terminal content is stale — tell the
  // renderer to clear that xterm view before the relaunched claude repaints.
  manager.on('reset', (paneId: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:reset', paneId)
    }
  })
  manager.on('closed', (paneId: string) => browserMgr.disposePane(paneId))
  browserMgr.on('tabs', (paneId: string, tabs: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser:tabs', paneId, tabs)
    }
    // Tab opened/closed/navigated → re-persist so a restart restores them.
    manager?.persistNow()
  })

  // ---- IPC ----
  ipcMain.handle('sessions:list', () => manager.list())
  ipcMain.handle('sessions:create', (_e, opts) => createSession(opts))
  ipcMain.handle('sessions:close', (_e, id: string) => manager.close(id))
  ipcMain.handle('sessions:restart', (_e, id: string) => manager.restart(id))
  ipcMain.handle('sessions:close-all', () => {
    manager.closeAll()
    killAllCockpitSessions() // sweep any tmux the dev session left behind
    return listCockpitSessions()
  })
  ipcMain.handle('sessions:rename', (_e, id: string, name: string) => manager.rename(id, name))
  ipcMain.handle('sessions:archive', (_e, id: string) => {
    manager.archive(id)
    return manager.listArchivedInfo()
  })
  ipcMain.handle('sessions:archived-list', () => manager.listArchivedInfo())
  ipcMain.handle('sessions:restore-archived', (_e, archivedId: string) =>
    manager.restoreArchived(archivedId)
  )
  ipcMain.handle('sessions:delete-archived', (_e, archivedId: string) => {
    manager.deleteArchived(archivedId)
    return manager.listArchivedInfo()
  })
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
  // External links (e.g. the issue chip → GitHub). https only, as a guard.
  ipcMain.on('app:open-external', (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle('app:relaunch', (_e, opts) => relaunchApp(opts))
  ipcMain.handle('tmux:available', () => isTmuxAvailable())
  ipcMain.handle('tmux:list', () => listCockpitSessions())
  ipcMain.handle('tmux:kill', (_e, name: string) => {
    killCockpitSession(name)
    return listCockpitSessions()
  })
  // ---- embedded browser IPC ----
  ipcMain.handle('browser:list', (_e, paneId: string) => browserMgr.listTabs(paneId))
  ipcMain.handle('browser:open', (_e, paneId: string, url?: string) => browserMgr.openTab(paneId, url))
  ipcMain.handle('browser:close', (_e, paneId: string, tabId: string) =>
    browserMgr.closeTab(paneId, tabId)
  )
  ipcMain.handle('browser:activate', (_e, paneId: string, tabId: string) =>
    browserMgr.activateTab(paneId, tabId)
  )
  ipcMain.handle('browser:navigate', (_e, paneId: string, tabId: string | null, url: string) =>
    browserMgr.navigate(paneId, tabId, url)
  )
  ipcMain.on('browser:set-bounds', (_e, paneId: string, bounds) =>
    browserMgr.setBounds(paneId, bounds)
  )
  ipcMain.on('browser:set-visible', (_e, paneId: string, visible: boolean) =>
    browserMgr.setVisible(paneId, visible)
  )
  // App-level modals ask us to force-hide the native browser overlay so it
  // doesn't paint over the dialog.
  ipcMain.on('browser:suppress-overlay', (_e, suppressed: boolean) =>
    browserMgr.setOverlaySuppressed(suppressed)
  )

  // ---- GitHub issues → dedicated sessions ----
  ipcMain.handle('issues:available', (_e, dir: string) => ghAvailable(expandTilde(dir)))
  ipcMain.handle('issues:list', (_e, dir: string) => listIssues(expandTilde(dir)))
  ipcMain.handle('issues:view', (_e, dir: string, number: number) =>
    viewIssue(expandTilde(dir), number)
  )
  ipcMain.handle('issues:start', (_e, workspaceId: string, number: number) =>
    startIssueSession(workspaceId, number)
  )
  ipcMain.handle('issues:done', (_e, paneId: string) => finishIssueSession(paneId))

  // ---- git (workspace push/pull) ----
  ipcMain.handle('git:status', (_e, dir: string, fetch?: boolean) =>
    gitStatus(expandTilde(dir), fetch)
  )
  ipcMain.handle('git:push', (_e, dir: string) => gitPush(expandTilde(dir)))
  ipcMain.handle('git:pull', (_e, dir: string) => gitPull(expandTilde(dir)))

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<AppSettings>) => updateSettings(patch))
  ipcMain.handle('dialog:pick-folder', () => pickFolder())
  ipcMain.handle('workspaces:list', () => listAllWorkspaces())
  ipcMain.handle('workspaces:save', (_e, ws: Workspace) => upsertWorkspace(ws))
  ipcMain.handle('workspaces:remove', (_e, id: string) => removeWorkspace(id))

  // Auto-update wiring (no-op outside a packaged build).
  initUpdater(() => mainWindow)

  // Restore panes from the previous run (resumes Claude conversations where possible).
  manager.restore()

  // Always keep a Cockpit Dev session open (when running in the app's own repo).
  const devAvailable =
    existsSync(join(REPO_ROOT, 'package.json')) && existsSync(join(REPO_ROOT, 'src'))
  if (devAvailable && !manager.list().some((s) => s.kind === 'dev')) {
    createDevSession()
  }
}

function getSettings(): AppSettings {
  return {
    killTmuxOnQuit: getFlag('killTmuxOnQuit'),
    hideCockpitWorkspace: getFlag('hideCockpitWorkspace')
  }
}

function updateSettings(patch: Partial<AppSettings>): AppSettings {
  if (typeof patch.killTmuxOnQuit === 'boolean') setFlag('killTmuxOnQuit', patch.killTmuxOnQuit)
  if (typeof patch.hideCockpitWorkspace === 'boolean')
    setFlag('hideCockpitWorkspace', patch.hideCockpitWorkspace)
  return getSettings()
}

/** The built-in "Cockpit" workspace — the app's own repo, synthesized (never stored). */
function cockpitWorkspace(): Workspace {
  return {
    id: COCKPIT_WORKSPACE_ID,
    name: 'Cockpit',
    path: REPO_ROOT,
    // Dev defaults: plain `claude`, no browser (the dev session is special).
    defaults: { dangerouslySkipPermissions: false, chrome: false, externalChrome: false, extraArgs: '' }
  }
}

/** All workspaces as shown in the UI: built-in Cockpit first (unless hidden), then the user's. */
function listAllWorkspaces(): Workspace[] {
  const devAvailable =
    existsSync(join(REPO_ROOT, 'package.json')) && existsSync(join(REPO_ROOT, 'src'))
  const base = getWorkspaces()
  if (!devAvailable || getFlag('hideCockpitWorkspace')) return base
  return [cockpitWorkspace(), ...base]
}

/** Resolve a workspace by id, including the built-in Cockpit one. */
function findWorkspace(id: string): Workspace | undefined {
  if (id === COCKPIT_WORKSPACE_ID) return cockpitWorkspace()
  return getWorkspaces().find((w) => w.id === id)
}

/** Info about the app's own repo + runtime. */
function appInfo(): {
  version: string
  repoRoot: string
  devAvailable: boolean
  isDev: boolean
  hooksJustInstalled: boolean
} {
  const devAvailable =
    existsSync(join(REPO_ROOT, 'package.json')) && existsSync(join(REPO_ROOT, 'src'))
  return {
    version: app.getVersion(),
    repoRoot: REPO_ROOT,
    devAvailable,
    isDev: !app.isPackaged,
    hooksJustInstalled
  }
}

/** Resolve cwd + default options from a workspace (if any) and spawn a session. */
function createSession(opts?: {
  workspaceId?: string | null
  cwd?: string
  command?: string
  name?: string
  options?: Partial<import('../shared/types.js').SessionOptions>
}): ReturnType<SessionManager['create']> {
  let { cwd, options } = opts ?? {}
  const workspaceId = opts?.workspaceId ?? null
  if (workspaceId) {
    const ws = findWorkspace(workspaceId)
    if (ws) {
      cwd = ws.path
      options = { ...ws.defaults, ...(opts?.options ?? {}) }
    }
  }
  return manager.create({ cwd, command: opts?.command, name: opts?.name, workspaceId, options })
}

/** The special "work on claude-cockpit itself" session, opened in the app's repo. */
function createDevSession(): ReturnType<SessionManager['create']> {
  return manager.create({
    cwd: REPO_ROOT,
    command: 'claude',
    name: 'Cockpit Dev',
    kind: 'dev',
    workspaceId: COCKPIT_WORKSPACE_ID,
    // Plain `claude` for self-development (no skip-permissions / chrome by default).
    options: { dangerouslySkipPermissions: false, chrome: false, externalChrome: false, extraArgs: '' }
  })
}

/**
 * Start a session dedicated to a GitHub issue: isolated worktree + branch, the
 * issue body staged next to the worktree (never committable), and a kickoff
 * prompt so Claude starts with full context. Reuses an existing session for the
 * same issue instead of duplicating.
 */
async function startIssueSession(
  workspaceId: string,
  number: number
): Promise<import('../shared/types.js').TerminalSession> {
  const ws = findWorkspace(workspaceId)
  if (!ws) throw new Error('workspace not found')
  const repoDir = expandTilde(ws.path)

  const existing = manager
    .list()
    .find((s) => s.issue && s.issue.repoDir === repoDir && s.issue.number === number)
  if (existing && existing.status !== 'exited') return existing
  // A dead pane for this issue (e.g. a failed launch) gets replaced, not reused.
  if (existing) manager.close(existing.id)

  const issue = await viewIssue(repoDir, number)
  const { worktree, branch } = await createIssueWorktree(repoDir, number, issue.title)

  const ref: IssueRef = { number, title: issue.title, url: issue.url, branch, worktree, repoDir }
  // The session gets the ENTIRE issue context inline, and plans before implementing.
  const comments = issue.comments.length
    ? `\n\nIssue comments:\n${issue.comments.map((c) => `[${c.author}]\n${c.body}`).join('\n\n')}`
    : ''
  const prompt =
    `You are working on GitHub issue #${number}: "${issue.title}" (${issue.url}).\n\n` +
    `Issue body:\n${issue.body.trim() || '(no description)'}${comments}\n\n` +
    `This directory is an isolated git worktree on branch ${branch}; ` +
    `your work is merged to the default branch separately when the user presses Done.\n\n` +
    `First: analyze the issue and present a concise plan — approach, files you expect to touch, ` +
    `and any risks or open questions. Wait for my confirmation before implementing.\n\n` +
    `After implementing, VALIDATE the fix yourself before calling it ready — do whatever you ` +
    `reasonably can to confirm it actually works, not just that the code looks right: run the ` +
    `project's build / tests / typecheck if they exist, and exercise the specific behavior the ` +
    `issue describes. If this is a web app, open it in your embedded browser and visually inspect ` +
    `the change really works (browser_open_tab / browser_navigate); if it's a desktop or CLI app, ` +
    `actually run it.\n\n` +
    `Then leave the fix OPEN and ready for me to review interactively — by default surface the ` +
    `running result so I can see it immediately: for a web app, load the relevant page in the ` +
    `embedded browser; for another app, launch it (externally if it can't run embedded). If it ` +
    `isn't obvious how I'd want to validate or review this change, ASK me how before finishing ` +
    `rather than guessing.\n\n` +
    `Once it's validated and committed here with clear messages, say it's ready — ` +
    `the user will press Done to merge and close the issue.`

  return manager.create({
    cwd: worktree,
    command: 'claude',
    // The #N chip already shows the number — the name is just the title.
    name: issue.title.slice(0, 60),
    workspaceId,
    options: ws.defaults,
    issue: ref,
    initialPrompt: prompt
  })
}

/**
 * The Done flow for an issue session: rebase → land on the default branch →
 * close the issue with a summary comment → retire the session. `dirty` and
 * `conflict` outcomes are typed INTO the session so its Claude fixes the state,
 * then Done is pressed again.
 */
async function finishIssueSession(paneId: string): Promise<IssueDoneResult> {
  const s = manager.list().find((x) => x.id === paneId)
  if (!s?.issue) return { ok: false, status: 'error', message: 'This session has no issue mapped.' }
  const { repoDir, worktree, branch, number } = s.issue

  const res = await finishIssueWorktree(repoDir, worktree, branch)
  if (res.status === 'dirty') {
    // sendPrompt types this then submits with a SEPARATE delayed Enter (a \r in the
    // same burst is treated as pasted text and won't submit). One line, no newlines.
    manager.sendPrompt(
      paneId,
      `Done was pressed for issue #${number}, but this worktree has uncommitted changes. ` +
        `Review them and either commit everything with clear messages or discard scratch files. ` +
        `Then make sure the fix is validated and leave it open for me to review — if it's a web app, ` +
        `open it in your embedded browser on the relevant page; otherwise run the app — then say "ready" or press Done again.`
    )
    res.message = `Issue #${number}: uncommitted changes — asked the session to commit/clean up and ready it for review, then press Done again.`
    return res
  }
  if (res.status === 'conflict') {
    // Hand the resolution to the session's Claude: finish the paused rebase, then
    // re-validate (the merge can change behavior) and surface the app for testing.
    manager.sendPrompt(
      paneId,
      `Done was pressed for issue #${number}, but rebasing your branch onto the default branch hit merge conflicts and the rebase is now paused in this worktree. ` +
        `Please resolve it yourself: run 'git status' to see the conflicted files, resolve each conflict carefully, 'git add' the resolved files, ` +
        `and run 'git rebase --continue' (repeat until the rebase finishes). ` +
        `Because merging in the latest default branch can change behavior, then re-validate the fix — run the build/tests and exercise the issue's behavior — ` +
        `and load the app up so I can test it interactively: for a web app, open it in your embedded browser and leave it on the relevant page; otherwise run the app. ` +
        `Tell me what you had to change to resolve the conflicts and confirm it still works, then I'll press Done again to merge.`
    )
    res.message = `Merge conflicts on issue #${number} — asked the session to resolve, re-validate, and load the app for you to test, then press Done again.`
    return res
  }
  if (res.status !== 'merged') return res

  // Close the issue with a summary; a failure here shouldn't undo the merge.
  try {
    await closeIssue(
      repoDir,
      number,
      `Completed via a Claude Cockpit session.\n\nCommits merged:\n${res.summary || '(none)'}`
    )
  } catch (e) {
    res.message += ` (Issue close failed: ${(e as Error).message} — close it manually.)`
  }
  manager.close(paneId)
  return res
}

/** Native folder picker; returns the chosen absolute path or null. */
async function pickFolder(): Promise<string | null> {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a workspace folder'
  })
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
}

/** Create or update a workspace (upsert by id); returns the full list. */
function upsertWorkspace(ws: Workspace): Workspace[] {
  // The built-in Cockpit workspace is synthesized — not editable/storable.
  if (ws.id === COCKPIT_WORKSPACE_ID) return listAllWorkspaces()
  // Normalize a hand-typed `~/...` path so sessions spawn in a real dir.
  ws = { ...ws, path: expandTilde(ws.path) }
  const list = getWorkspaces()
  const i = list.findIndex((w) => w.id === ws.id)
  if (i === -1) list.push(ws)
  else list[i] = ws
  saveWorkspaces(list)
  return listAllWorkspaces()
}

/** Remove a workspace by id; returns the remaining list. (Hide Cockpit via Settings instead.) */
function removeWorkspace(id: string): Workspace[] {
  if (id !== COCKPIT_WORKSPACE_ID) {
    // Close its live sessions too — leaving them orphaned in "Other" is confusing.
    manager.closeForWorkspace(id)
    saveWorkspaces(getWorkspaces().filter((w) => w.id !== id))
  }
  return listAllWorkspaces()
}

function runBuild(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(NPM_BIN, ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' })
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
    // macOS: inset traffic-lights over the renderer. Windows: a hidden title bar
    // with an overlay so the min/max/close controls still render (Linux gets the
    // default frame). `hiddenInset` is macOS-only and would throw elsewhere.
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    titleBarOverlay: IS_MAC ? undefined : { color: '#14161b', symbolColor: '#c8ccd4', height: 36 },
    icon: ICON_PNG,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Embedded-browser WebContentsViews overlay this window.
  browserMgr?.setWindow(mainWindow)

  const wc = mainWindow.webContents
  const devUrl = process.env.ELECTRON_RENDERER_URL

  const load = (): void => {
    if (devUrl) mainWindow!.loadURL(devUrl)
    else mainWindow!.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // If the renderer is loaded before the dev server is serving (common during a
  // restart triggered by editing cockpit from inside cockpit), retry instead of
  // leaving a blank window. -3 is ERR_ABORTED (a normal navigation), so ignore it.
  let retries = 0
  wc.on('did-fail-load', (_e, code) => {
    if (code === -3 || mainWindow?.isDestroyed()) return
    if (retries++ < 20) setTimeout(load, 300)
  })

  // If the renderer process crashes or hangs, reload it rather than showing black.
  wc.on('render-process-gone', (_e, details) => {
    console.error('[cockpit] renderer gone:', details.reason)
    if (!mainWindow?.isDestroyed() && details.reason !== 'clean-exit') load()
  })
  wc.on('unresponsive', () => {
    console.error('[cockpit] renderer unresponsive — reloading')
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
  })

  load()
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
  browserRpc?.close()
  sessionsRpc?.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Only kill tmux sessions on a real quit if the user opted in. Dev restarts
  // (which SIGTERM the process) generally skip before-quit, so survival is preserved.
  if (getFlag('killTmuxOnQuit')) killAllCockpitSessions()
  manager?.disposeAll()
  ingest?.close()
  browserRpc?.close()
  sessionsRpc?.close()
})
