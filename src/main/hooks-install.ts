import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { quotePath } from './platform.js'

const SETTINGS = join(homedir(), '.claude', 'settings.json')

/** Hook events claude-cockpit listens to for status + sub-agent signals. */
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'SubagentStop',
  'SessionEnd'
]

export interface HookInstallState {
  installed: boolean
  command: string | null
}

function hookCommandFor(emitScriptPath: string): string {
  // process.execPath is Electron; for hooks we want plain node on PATH. quotePath
  // (not JSON.stringify) so a Windows `C:\…` path keeps single backslashes instead
  // of being doubled into an invalid path when Claude runs the hook command. On
  // POSIX quotePath === JSON.stringify, so the stored command string is unchanged.
  return `node ${quotePath(emitScriptPath)}`
}

function readSettings(): any {
  if (!existsSync(SETTINGS)) return {}
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8')) || {}
  } catch {
    return {}
  }
}

export function hookStatus(emitScriptPath: string): HookInstallState {
  const cmd = hookCommandFor(emitScriptPath)
  const s = readSettings()
  const hooks = s.hooks || {}
  const present = EVENTS.every((evt) =>
    (hooks[evt] || []).some((g: any) =>
      (g.hooks || []).some((h: any) => h?.command === cmd)
    )
  )
  return { installed: present, command: cmd }
}

/** Idempotently add our emit command to each event group. Backs up first. */
export function installHooks(emitScriptPath: string): HookInstallState {
  const cmd = hookCommandFor(emitScriptPath)
  if (existsSync(SETTINGS)) {
    copyFileSync(SETTINGS, `${SETTINGS}.claude-cockpit.bak`)
  }
  const s = readSettings()
  s.hooks = s.hooks || {}
  for (const evt of EVENTS) {
    s.hooks[evt] = s.hooks[evt] || []
    const already = s.hooks[evt].some((g: any) =>
      (g.hooks || []).some((h: any) => h?.command === cmd)
    )
    if (!already) {
      s.hooks[evt].push({ matcher: '', hooks: [{ type: 'command', command: cmd }] })
    }
  }
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2))
  return { installed: true, command: cmd }
}

/** Remove our emit command from all event groups. */
export function uninstallHooks(emitScriptPath: string): HookInstallState {
  const cmd = hookCommandFor(emitScriptPath)
  const s = readSettings()
  const hooks = s.hooks || {}
  for (const evt of EVENTS) {
    if (!hooks[evt]) continue
    hooks[evt] = hooks[evt]
      .map((g: any) => ({
        ...g,
        hooks: (g.hooks || []).filter((h: any) => h?.command !== cmd)
      }))
      .filter((g: any) => (g.hooks || []).length > 0)
    if (hooks[evt].length === 0) delete hooks[evt]
  }
  s.hooks = hooks
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2))
  return { installed: false, command: cmd }
}
