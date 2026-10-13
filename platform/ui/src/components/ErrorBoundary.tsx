import { Component, type ReactNode, type ErrorInfo } from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

/**
 * Error Boundary to prevent black screen crashes
 * Catches rendering errors and displays a recovery UI instead of unmounting
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '60vh',
            padding: '2rem',
            background: '#07090e',
            color: '#e2e8f0',
            fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '1rem',
              maxWidth: '600px',
              textAlign: 'center',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: '12px',
              padding: '2rem',
              background: 'rgba(239, 68, 68, 0.05)',
              backdropFilter: 'blur(8px)',
            }}
          >
            <div style={{ fontSize: '3rem' }}>⚠️</div>
            <h2 style={{ margin: 0, color: '#ef4444', fontSize: '1.25rem', fontWeight: 600 }}>
              System Diagnostics Recovery
            </h2>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.875rem', lineHeight: 1.5 }}>
              An unexpected error was caught by the NeuroFabric safety net.
              The dashboard has been paused to prevent data corruption.
            </p>
            <details
              style={{
                textAlign: 'left',
                width: '100%',
                marginTop: '1rem',
                padding: '1rem',
                background: '#0d121d',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '8px',
                color: '#64748b',
                fontSize: '0.75rem',
              }}
            >
              <summary style={{ cursor: 'pointer', color: '#ef4444', fontWeight: 600 }}>
                Error Details (click to expand)
              </summary>
              <pre style={{ margin: '0.5rem 0 0', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                {this.state.error?.message ?? 'Unknown error'}
                {this.state.errorInfo?.componentStack ? `\n\n${this.state.errorInfo.componentStack}` : ''}
              </pre>
            </details>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
              <button
                onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
                style={{
                  padding: '0.625rem 1.25rem',
                  background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
                  color: '#07090e',
                  border: 'none',
                  borderRadius: '8px',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Retry Dashboard
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: '0.625rem 1.25rem',
                  background: 'transparent',
                  color: '#94a3b8',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: '8px',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Full Reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * HOC wrapper for easy use
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  errorBoundaryProps?: Omit<ErrorBoundaryProps, 'children'>
): React.FC<P> {
  return (props) => (
    <ErrorBoundary {...errorBoundaryProps}>
      <WrappedComponent {...props} />
    </ErrorBoundary>
  );
}