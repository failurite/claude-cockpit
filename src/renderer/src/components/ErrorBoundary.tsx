import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * Catches render/lifecycle errors so a thrown component shows a recoverable
 * panel instead of a black screen. Especially important when editing cockpit
 * from inside cockpit, where restarts can briefly desync preload vs renderer.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console for the dev session to read.
    console.error('[cockpit] render error:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <div className="crash-card">
          <h2>Something threw while rendering.</h2>
          <p className="crash-msg">{error.message}</p>
          <pre className="crash-stack">{error.stack}</pre>
          <div className="crash-actions">
            <button onClick={() => this.setState({ error: null })}>Try again</button>
            <button className="primary" onClick={() => window.location.reload()}>
              Reload window
            </button>
          </div>
          <p className="crash-hint">
            Your terminal sessions are still alive in the background and will
            reattach on reload.
          </p>
        </div>
      </div>
    )
  }
}
