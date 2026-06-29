import { useCallback, useEffect, useState } from 'react'
import type { GitStatus } from '../../../shared/types'

/**
 * Live git status for a directory. Reads immediately on mount, does a one-shot
 * background fetch for an accurate behind-count, then polls the LOCAL status on
 * an interval and re-fetches on window focus — so a repo or remote that appears
 * AFTER mount (e.g. a session ran `git init` + push) shows up without a manual
 * refresh. A network `git fetch` only runs on mount / focus / `reload(true)`,
 * never on the cheap interval.
 */
export function useGitStatus(path: string): {
  status: GitStatus | null
  reload: (fetch?: boolean) => Promise<void>
} {
  const [status, setStatus] = useState<GitStatus | null>(null)

  const reload = useCallback(
    async (fetch = false): Promise<void> => {
      if (!path) return
      setStatus(await window.cockpit.git.status(path, fetch))
    },
    [path]
  )

  useEffect(() => {
    if (!path) {
      setStatus(null)
      return
    }
    let alive = true
    const read = (fetch: boolean): void => {
      window.cockpit.git.status(path, fetch).then((s) => alive && setStatus(s))
    }
    read(false) // fast local read
    read(true) // background fetch for an accurate behind-count
    const iv = setInterval(() => {
      if (document.visibilityState === 'visible') read(false)
    }, 5000)
    const onFocus = (): void => read(true)
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      clearInterval(iv)
      window.removeEventListener('focus', onFocus)
    }
  }, [path])

  return { status, reload }
}
