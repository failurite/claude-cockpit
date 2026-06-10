/**
 * Cross-platform helpers for spawning the per-pane shell that runs `claude`.
 *
 * The app embeds the real `claude` TUI in each pane by spawning a shell through
 * node-pty and having it run the claude launch command. macOS/Linux and Windows
 * differ in (a) which shell to spawn, (b) how to make the pane *be* the target
 * process with no lingering prompt, and (c) how to quote arguments so they
 * survive the shell. This module is the single choke point for those differences
 * so the rest of the main process stays platform-neutral.
 */

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/**
 * Quote one argument so it survives word-splitting inside a launch string.
 * - POSIX: single quotes, with embedded `'` escaped as `'\''`.
 * - Windows (cmd.exe): double quotes, with embedded `"` doubled.
 * Used for free-text bits (e.g. a kickoff prompt) that get concatenated into the
 * command line we hand the shell.
 */
export function quoteArg(s: string): string {
  if (IS_WINDOWS) return `"${s.replace(/"/g, '""')}"`
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * The (shell, args) pair node-pty spawns to run a launch command line so the pane
 * *is* the target process.
 * - POSIX: a login shell (`-l`) so a GUI-launched app still inherits the user's
 *   PATH, then `exec` so no shell prompt lingers once the target exits.
 * - Windows: cmd.exe `/d /s /c` runs the command and exits when it does (no
 *   lingering prompt); a GUI-launched app already inherits the user PATH from the
 *   registry, so no login-shell dance is needed.
 */
export function buildShellInvocation(launch: string): { shell: string; args: string[] } {
  if (IS_WINDOWS) {
    const shell = process.env.ComSpec || 'cmd.exe'
    return { shell, args: ['/d', '/s', '/c', launch] }
  }
  const shell = process.env.SHELL || '/bin/zsh'
  return { shell, args: ['-l', '-c', `exec ${launch}`] }
}

/**
 * Quote a filesystem path embedded in a command string so spaces survive the
 * shell. On POSIX this is `JSON.stringify` (double quotes — unchanged from before,
 * so persisted/compared command strings stay byte-identical). On Windows it wraps
 * the raw path in double quotes WITHOUT escaping: JSON.stringify would double the
 * backslashes of a `C:\…` path into an invalid path. Windows paths can't contain
 * a `"`, so no escaping is needed.
 */
export function quotePath(p: string): string {
  return IS_WINDOWS ? `"${p}"` : JSON.stringify(p)
}

/**
 * The npm executable to spawn. On Windows npm is a `.cmd` shim, which
 * child_process can't resolve from the bare name without a shell.
 */
export const NPM_BIN = IS_WINDOWS ? 'npm.cmd' : 'npm'
