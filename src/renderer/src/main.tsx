import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

// Last-resort visibility: log async errors that an error boundary can't catch.
window.addEventListener('error', (e) => console.error('[cockpit] window error:', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) =>
  console.error('[cockpit] unhandled rejection:', e.reason)
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
