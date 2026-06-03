# Contributing

Thanks for your interest! `claude-cockpit` is small and easy to hack on.

## Dev setup

Requirements: macOS, Node 20+, `claude` on `PATH`.

```bash
npm install
npm run dev        # hot-reloading app
npm run build      # production bundle into out/
npm run typecheck  # tsc on main+preload and renderer
```

Verify the native terminal backend and the embedded-browser control layer load
under your Electron:

```bash
npx electron scripts/pty-smoke.cjs          # prints PTY_OUTPUT:"pty-ok"
npx electron scripts/webview-cdp-smoke.cjs  # prints SMOKE_RESULT: PASS
```

To test against the installed Desktop app, `npm run update-app` rebuilds and
swaps it in place (see the README's "Updating" section).

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full map. The short
version:

- `src/main/` — Electron main: ptys, hook ingest server, embedded-browser
  manager + RPC, git, tmux dev session, transcript watcher, store.
- `src/preload/` — the `window.cockpit` bridge.
- `src/renderer/` — React UI (Sidebar, WorkspaceGit, TerminalView, BrowserPanel,
  LaunchDialog, SettingsPanel, App).
- `src/shared/types.ts` — the single source of truth for the main↔renderer
  contract. Change this first when adding a feature.
- `hooks/emit.mjs` — the hook handler Claude runs.
- `mcp/cockpit-browser.mjs` — the stdio MCP server that gives sessions their
  embedded browser tools.

## Good first issues

- **Split/grid layout** — show more than one terminal at once.
- **More precise sub-agent counting** — see `transcripts.ts`.
- **Real synthetic input for the embedded browser** — upgrade click/type from
  `executeJavaScript` to CDP `Input.dispatch*` (`scripts/webview-cdp-smoke.cjs`
  already proves the approach).
- **Windows/Linux** — the stack is cross-platform but untested off macOS.

## Conventions

- TypeScript, strict mode. Keep the `shared/types.ts` contract honest.
- Keep the hook handler (`emit.mjs`) dependency-free and non-blocking.
- Status detection stays **out-of-band** — don't scrape terminal output to infer
  state; use hooks / transcripts.
- Match the existing code style (no formatter config is enforced yet; keep it
  consistent with surrounding code).

## Pull requests

Small, focused PRs are easiest to review. Please run `npm run build` and the pty
smoke test before opening one. Describe what you changed and why.
