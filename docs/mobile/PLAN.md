# Cockpit Mobile — build plan

Monitor and interact with Cockpit sessions from a phone/tablet on the same LAN.
Hi-fi mockups: [`docs/mockups/cockpit-mobile.html`](../mockups/cockpit-mobile.html)
(open in a browser).

## Principle
The Mac stays the single source of truth and the only place work runs. The phone
is a **thin remote client** to the existing main-process services (`SessionManager`,
git, issues, monitor, browser). We add a new *transport* (a LAN gateway) that
fronts the same operations the Electron renderer already uses — we don't
reimplement logic, and `src/shared/types.ts` stays the shared contract.

```
 Phone (mobile-first web app / PWA)
        │  Wi-Fi (same LAN)
        ▼
 HTTP/SSE (+later WS) gateway  ← in Electron main, bound to 0.0.0.0, token-gated
        │  (same services as the IPC handlers)
        ▼
 SessionManager · monitor · git · issues · worktrees · browser · store
```

Client = a **PWA** (responsive web app the Mac serves): reuses the web stack,
installs to the home screen, no App Store. Native app only if the PWA hits limits.

## Phases

### Phase 1 — read-only live dashboard (IN PROGRESS)
The first testable slice. No auth pairing UI, no STT, no notifications.
- `src/main/gateway.ts`: HTTP server on `0.0.0.0:47618`, **token-gated** (random
  token persisted in the store; required on every request). Serves a
  self-contained mobile client and a **Server-Sent Events** stream
  (`/events`) — SSE is one-directional and dependency-free, ideal for pushing
  session/stat updates. Also a plain `/api/sessions` JSON fallback.
- `src/main/mobile-client.ts`: the mobile web app (live session list + status +
  system stats), styled like the mockup.
- Surface the phone URL (`http://<lan-ip>:47618/?token=…`) in Settings so you can
  type it into a phone once.
- **Test:** open the URL on your phone → see sessions update live as they change.

### Phase 2 — interactive terminals
Lean on tmux (each pane is already a tmux client on `cockpit-<id>`): attach
another client for the phone so views stay in sync. Upgrade the transport to
WebSocket for bidirectional pty I/O; xterm.js in the phone client + a mobile key
toolbar (Esc/Ctrl/Tab/arrows). Set tmux `window-size latest` so the phone
attaching doesn't shrink the Mac terminal.

### Phase 3 — git, issues, session controls
Push/pull, issue list/view, **start issue**, **Done**, model switch, restart,
archive — all RPC over the gateway to existing services. New-work composer.

### Phase 4 — the house-app view (Live / Mirror)
- **Live:** phone loads the workspace's dev server directly over LAN
  (`http://<mac-ip>:<port>`) in an in-app webview — real mobile viewport for
  testing the app being built. Needs a per-workspace "app URL/port" setting and
  the dev server bound to `0.0.0.0`.
- **Mirror:** CDP `Page.startScreencast` of the session's embedded
  `WebContentsView` + `Input.dispatch*` for taps/keys (proven by
  `scripts/webview-cdp-smoke.cjs`). Shows and drives exactly what the agent sees.

### Phase 5 — renewal → continue (deferred per request)
Detect a session hitting its usage limit + its reset time (out-of-band — there is
**no usage API**; needs a spike), mark it `out of tokens`, and web-push at reset
with per-session **Continue** / **Continue all** / **Start new work**.

### Phase 6 — voice input (deferred per request)
Hold-to-talk on the phone → audio to the gateway → **local Whisper on the Mac**
(`whisper.cpp`, CoreML) → text into the session input. iOS keyboard dictation as
fallback. Review-then-send by default; auto-send opt-in.

## Cross-cutting
- **Security:** token on every request (Phase 1). Later: QR pairing, self-signed
  TLS, same-subnet check, a "phone connected" indicator, revoke/re-pair.
- **Discovery:** URL/QR in the Mac app now; mDNS/Bonjour (`_cockpit._tcp`) later.
- **Refactor payoff:** extracting IPC handler bodies into plain services (so both
  IPC and the gateway call them) is the enabling work and improves testability.

## Open questions
- Renewal detection without a usage API (Phase 5 spike).
- tmux multi-client size negotiation (Phase 2).
- iOS PWA push reliability (may motivate a native shell for Phase 5).
- Browser screencast bandwidth/latency tuning (Phase 4).
