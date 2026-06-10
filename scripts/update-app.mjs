// Cross-platform dispatcher for `npm run update-app`: rebuild Claude Cockpit and
// swap the locally-installed app in place, then relaunch it. Picks the right
// platform script — bash on macOS/Linux, PowerShell on Windows. (The real work
// lives in install-local.sh / install-local.ps1, which differ enough per OS that
// a single script would be all branches.)
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'

const { file, args } = isWin
  ? {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'install-local.ps1')]
    }
  : { file: 'bash', args: [join(here, 'install-local.sh')] }

const res = spawnSync(file, args, { stdio: 'inherit' })
if (res.error) {
  console.error(`✗ Failed to run updater (${file}): ${res.error.message}`)
  process.exit(1)
}
process.exit(res.status ?? 0)
