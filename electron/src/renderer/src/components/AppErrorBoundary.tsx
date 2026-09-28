import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '@shared/i18n'

// Without a boundary React unmounts the whole tree on an uncaught render or
// effect error and the window goes blank with nothing to act on.
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] render error', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return <div className="app-crash" role="alert">
      <h1>{t('app.crashed.title')}</h1>
      <p>{t('app.crashed.body')}</p>
      <pre>{this.state.error.stack || this.state.error.message}</pre>
      <button type="button" className="primary-button" onClick={() => window.location.reload()}>{t('app.crashed.reload')}</button>
    </div>
  }
}
