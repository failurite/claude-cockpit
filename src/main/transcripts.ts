import chokidar, { type FSWatcher } from 'chokidar'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readdirSync, readFileSync } from 'fs'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** Find <sessionId>.jsonl under any project folder. */
function locate(sessionId: string): string | null {
  if (!existsSync(PROJECTS_DIR)) return null
  for (const proj of readdirSync(PROJECTS_DIR)) {
    const candidate = join(PROJECTS_DIR, proj, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Count *active* sub-agents by scanning the transcript for `Task` tool calls
 * that don't yet have a matching tool_result. This is a heuristic (v1) but maps
 * directly to the sidechains Claude spawns.
 */
function countActiveSubagents(file: string): number {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  const open = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const content = entry?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_use' && block?.name === 'Task') {
        open.add(block.id)
      } else if (block?.type === 'tool_result' && block?.tool_use_id) {
        open.delete(block.tool_use_id)
      }
    }
  }
  return open.size
}

/**
 * Watch a Claude session's transcript and report the active sub-agent count.
 * The file may not exist yet at bind time, so we also watch the projects dir
 * for its creation. Returns a dispose function.
 */
export function watchTranscriptForSession(
  sessionId: string,
  onCount: (count: number) => void
): () => void {
  let fileWatcher: FSWatcher | null = null
  let last = -1

  const report = (file: string): void => {
    const n = countActiveSubagents(file)
    if (n !== last) {
      last = n
      onCount(n)
    }
  }

  const attach = (file: string): void => {
    if (fileWatcher) return
    report(file)
    fileWatcher = chokidar.watch(file, { ignoreInitial: true })
    fileWatcher.on('change', () => report(file))
  }

  const found = locate(sessionId)
  let dirWatcher: FSWatcher | null = null
  if (found) {
    attach(found)
  } else if (existsSync(PROJECTS_DIR)) {
    // Wait for the transcript file to appear.
    dirWatcher = chokidar.watch(PROJECTS_DIR, {
      ignoreInitial: true,
      depth: 1
    })
    dirWatcher.on('add', (p: string) => {
      if (p.endsWith(`${sessionId}.jsonl`)) {
        dirWatcher?.close()
        dirWatcher = null
        attach(p)
      }
    })
  }

  return () => {
    fileWatcher?.close()
    dirWatcher?.close()
  }
}
