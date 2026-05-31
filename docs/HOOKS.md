# Status hooks

`claude-cockpit` derives live session status from Claude Code **hooks**. This page
documents exactly what it writes to your machine, so there are no surprises.

## What gets installed

Clicking **Install status hooks** (or calling `cockpit.hooks.install()`) edits
`~/.claude/settings.json`:

- It first copies the file to `~/.claude/settings.json.claude-cockpit.bak`.
- It adds one `command` hook — `node /abs/path/to/claude-cockpit/hooks/emit.mjs` —
  to each of these events:

  `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
  `Notification`, `SubagentStop`, `SessionEnd`.

The edit is **idempotent** (re-installing won't duplicate entries) and **additive**
(your existing hooks are preserved). Example of what a single entry looks like:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node \"/Users/you/code/claude-cockpit/hooks/emit.mjs\"" }
        ]
      }
    ]
  }
}
```

## What the hook does

`hooks/emit.mjs` is intentionally tiny and dependency-free. On each event it:

1. Reads the hook event JSON from stdin.
2. Adds `cockpit_pane_id` from the `CLAUDE_COCKPIT_PANE_ID` env var (inherited from
   the terminal the app spawned).
3. POSTs the result to `http://127.0.0.1:$CLAUDE_COCKPIT_INGEST_PORT/`.
4. Exits `0` within ~1.5s no matter what — it never blocks or delays Claude.

If the app isn't running (no port in the environment), it exits immediately and
does nothing. It only ever talks to `127.0.0.1`.

## Removing the hooks

- In-app: re-open the banner action, or call `cockpit.hooks.uninstall()`.
- Manually: delete the `claude-cockpit` `emit.mjs` command entries from
  `~/.claude/settings.json`, or restore the `.claude-cockpit.bak` backup.

## Privacy

Hook payloads (event name, `session_id`, `cwd`, tool name, notification type) are
sent only to the local app over loopback. Nothing leaves your machine.
