import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Console caught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#07090e] text-white flex flex-col items-center justify-center p-6 text-center font-sans">
          <div className="w-16 h-16 rounded-2xl bg-rose-950/40 border border-rose-800 flex items-center justify-center mb-4 text-rose-400">
            <AlertOctagon className="w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold font-mono">Console Boundary Exception</h1>
          <p className="text-xs text-slate-400 max-w-md mt-2 font-mono">
            {this.state.error?.message || 'An unexpected rendering error occurred.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 px-4 py-2 bg-slate-900 border border-slate-700 hover:border-cyan-500 rounded-xl text-xs font-mono font-bold text-cyan-400 flex items-center space-x-2 transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reload Console</span>
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
