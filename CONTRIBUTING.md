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

Verify the native terminal backend loads under your Electron:

```bash
npx electron scripts/pty-smoke.cjs   # prints PTY_OUTPUT:"pty-ok"
```

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full map. The short
version:

- `src/main/` — Electron main: ptys, hook ingest server, transcript watcher.
- `src/preload/` — the `window.cockpit` bridge.
- `src/renderer/` — React UI (Sidebar, TerminalView, App).
- `src/shared/types.ts` — the single source of truth for the main↔renderer
  contract. Change this first when adding a feature.
- `hooks/emit.mjs` — the hook handler Claude runs.

## Good first issues

- **Split/grid layout** — show more than one terminal at once.
- **More precise sub-agent counting** — see `transcripts.ts`.
- **Chrome tab mirror** — the big one; see the
  [Chrome integration](docs/ARCHITECTURE.md#chrome-integration) section and
  validate the CDP screencast feasibility question first.
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
