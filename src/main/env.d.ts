// Build-time constant injected by electron.vite.config.ts (`define`). Holds the
// absolute path of the source repo the app was built from, so the packaged app
// can open its "Cockpit Dev" session in the real checkout (not the .app bundle).
declare const __REPO_ROOT__: string
