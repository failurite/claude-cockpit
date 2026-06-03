# Status hooks

`claude-cockpit` derives live session status from Claude Code **hooks**. This page
documents exactly what it writes to your machine, so there are no surprises.

## What gets installed

Cockpit **auto-installs the hooks once, on first launch** (if that fails or you
remove them, install manually via **Settings → Status hooks**, or
`cockpit.hooks.install()`). The auto-install is attempted only once ever — if you
uninstall, Cockpit won't fight you by re-adding them. Installing edits
`~/.claude/settings.json`:

- It first copies the file to `~/.claude/settings.json.claude-cockpit.bak`.
- It adds one `command` hook to each of these events — the command is
  `node <path>/hooks/emit.mjs`, where `<path>` is the repo in dev or
  `Claude Cockpit.app/Contents/Resources` in the packaged app:

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

- In-app: **Settings → Status hooks → Uninstall**, or call
  `cockpit.hooks.uninstall()`.
- Manually: delete the `claude-cockpit` `emit.mjs` command entries from
  `~/.claude/settings.json`, or restore the `.claude-cockpit.bak` backup.

## Troubleshooting

If every pane sits on **"starting…"** forever, the hooks are missing or broken —
most commonly `~/.claude/settings.json` was recreated without its `hooks` block
(e.g. by a migration). Re-install from **Settings → Status hooks** and restart
the affected sessions (a running Claude session only reads hook config at
startup).

## Privacy

Hook payloads (event name, `session_id`, `cwd`, tool name, notification type) are
sent only to the local app over loopback. Nothing leaves your machine.
