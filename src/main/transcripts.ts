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
 * True if a transcript exists for this Claude session id. Used to avoid
 * `claude --resume <id>` on a conversation whose transcript is gone (deleted,
 * cloud-evicted, or from another machine) — which would otherwise leave a broken
 * pane stuck on "No conversation found with session ID".
 */
export function transcriptExists(sessionId: string): boolean {
  return locate(sessionId) !== null
}

/** Live stats derived from one scan of a session's transcript. */
export interface TranscriptStats {
  /** Active sub-agents: `Task` tool calls without a matching tool_result yet. */
  subagents: number
  /** Cumulative tokens (input + output + cache-creation) across assistant turns. */
  tokens: number
}

/**
 * Scan a transcript once for both the active sub-agent count and cumulative
 * token usage. Sub-agents are a heuristic (open `Task` tool_use ids). Tokens sum
 * each assistant turn's `usage` — input + output + cache-creation, deliberately
 * excluding `cache_read_input_tokens` (cheap, and it re-reads the whole context
 * every turn, which would swamp the meter).
 */
function readTranscriptStats(file: string): TranscriptStats {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { subagents: 0, tokens: 0 }
  }
  const open = new Set<string>()
  let tokens = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const message = entry?.message
    const content = message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && block?.name === 'Task') {
          open.add(block.id)
        } else if (block?.type === 'tool_result' && block?.tool_use_id) {
          open.delete(block.tool_use_id)
        }
      }
    }
    const u = message?.usage
    if (u && message?.role === 'assistant') {
      tokens +=
        (u.input_tokens || 0) +
        (u.output_tokens || 0) +
        (u.cache_creation_input_tokens || 0)
    }
  }
  return { subagents: open.size, tokens }
}

/** A compact, coordination-oriented summary of another session's transcript. */
export interface SessionDigest {
  /** True if the transcript file was found and read. */
  found: boolean
  /** Total user+assistant turns seen (rough size signal). */
  turns: number
  /** The most recent human prompts (oldest→newest), trimmed. */
  prompts: string[]
  /** The latest non-empty assistant narrative text, trimmed. */
  lastAssistant: string
  /** Files this session edited/created (from Edit/Write/MultiEdit/NotebookEdit), de-duped. */
  filesTouched: string[]
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** Pull the plain text out of a transcript message's `content` (string or block array). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && (b as { type?: string }).type === 'text')
    .map((b) => (b as { text?: string }).text || '')
    .join('\n')
}

/** True if a user entry is a real human prompt (not a tool_result return or meta line). */
function isHumanPrompt(entry: { isMeta?: boolean; message?: { content?: unknown } }): boolean {
  if (entry.isMeta) return false
  const content = entry.message?.content
  if (Array.isArray(content) && content.some((b) => (b as { type?: string })?.type === 'tool_result')) {
    return false // a tool result fed back to Claude, not something the user typed
  }
  const t = textOf(content).trim()
  if (!t) return false
  // Skip harness-injected scaffolding (command stubs, caveats, reminders).
  if (/^<(command-|local-command|user-prompt-submit)/.test(t)) return false
  if (t.startsWith('Caveat:')) return false
  return true
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Read a session's transcript and distil it into a small digest other sessions
 * can consult for coordination (what it's working on + which files it touches).
 * Pure on-disk read — no effect on the session itself.
 */
export function sessionDigest(
  claudeSessionId: string,
  opts: { maxPrompts?: number; promptChars?: number } = {}
): SessionDigest {
  const maxPrompts = opts.maxPrompts ?? 6
  const promptChars = opts.promptChars ?? 400
  const empty: SessionDigest = { found: false, turns: 0, prompts: [], lastAssistant: '', filesTouched: [] }
  const file = locate(claudeSessionId)
  if (!file) return empty
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return empty
  }
  const prompts: string[] = []
  const files: string[] = []
  let lastAssistant = ''
  let turns = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const role = entry?.message?.role
    if (role === 'user') {
      if (isHumanPrompt(entry)) {
        turns++
        prompts.push(clip(textOf(entry.message.content), promptChars))
      }
    } else if (role === 'assistant') {
      turns++
      const content = entry?.message?.content
      const t = textOf(content).trim()
      if (t) lastAssistant = clip(t, 800)
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && EDIT_TOOLS.has(block?.name)) {
            const fp = block?.input?.file_path || block?.input?.notebook_path
            if (typeof fp === 'string' && !files.includes(fp)) files.push(fp)
          }
        }
      }
    }
  }
  return {
    found: true,
    turns,
    prompts: prompts.slice(-maxPrompts),
    lastAssistant,
    filesTouched: files.slice(-40)
  }
}

/**
 * Watch a Claude session's transcript and report its live stats (active
 * sub-agent count + cumulative tokens). The file may not exist yet at bind time,
 * so we also watch the projects dir for its creation. Returns a dispose function.
 */
export function watchTranscriptForSession(
  sessionId: string,
  onStats: (stats: TranscriptStats) => void
): () => void {
  let fileWatcher: FSWatcher | null = null
  let lastSubagents = -1
  let lastTokens = -1

  const report = (file: string): void => {
    const s = readTranscriptStats(file)
    if (s.subagents !== lastSubagents || s.tokens !== lastTokens) {
      lastSubagents = s.subagents
      lastTokens = s.tokens
      onStats(s)
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
